import { send as sendTelegram, findChatId } from './telegram.js'
import { fetchOrders, keyFor } from './playconsole.js'
import { load, isConfigured } from './settings.js'
import { plan } from './filters.js'
import { describe, label } from './format.js'
import { t } from './i18n.js'
import { shouldAlert, FAILS_BEFORE_ALERT } from './health.js'
import { record, recordOnce, clear as clearLog } from './log.js'

// pending is not an event, it is an order on its way to becoming one. Notifying
// on it means notifying twice — once pending, again when it settles, since the
// dedupe key carries state. Ignoring it entirely also keeps it out of `seen`, so
// the charge that follows still reads as new.
const TERMINAL_STATES = new Set(['charged', 'refunded'])

const ALARM = 'poll'
const MAX_SEEN = 5000
const MAX_MESSAGES = 10

const state = () =>
  chrome.storage.local.get({
    seen: [], delivered: [], bootstrapped: false, fails: 0, lastAlertAt: 0, lastOkAt: 0,
  })

// Reset must win over a poll that is already mid-flight. A poll captures the
// epoch when it starts and stops writing if it changed, rather than restoring
// the history the user just asked to clear.
let resetEpoch = 0

// ------------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await rearm()
  // Nothing works until a bot token exists, so a fresh install goes straight to
  // the one screen that can fix that.
  if (reason === 'install') chrome.runtime.openOptionsPage()
})
chrome.runtime.onStartup.addListener(rearm)
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage())

async function rearm() {
  const { intervalMinutes } = await load()
  await chrome.alarms.clear(ALARM)
  await chrome.alarms.create(ALARM, {
    periodInMinutes: Math.max(1, intervalMinutes),
    // A short first delay so pressing Save gives visible feedback rather than
    // leaving the user to wonder for a full period.
    delayInMinutes: 0.5,
  })
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return
  // The alarm has no one to reject to; an unhandled rejection would take the
  // worker down and stop the schedule silently.
  poll().catch((err) => console.warn('[kaching] poll failed', err))
})

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const handlers = {
    poll: () => poll(),
    rearm: () => rearm(),
    findChatId: async () => findChatId(msg.botToken || (await load()).botToken),
    test: async () => {
      const s = await load()
      if (!s.botToken || !s.chatId) throw new Error(t('msgNeedSetup'))
      return sendTelegram(s.botToken, s.chatId, label(s, t('tgConnected')))
    },
    reset: async () => {
      resetEpoch += 1
      await chrome.storage.local.set({
        seen: [], delivered: [], bootstrapped: false, fails: 0, lastAlertAt: 0,
      })
      badge('', '#9e9e9e')
      await record('info', 'logReset')
      return 'cleared'
    },
    clearLog: async () => {
      await clearLog()
      return 'cleared'
    },
    status: async () => {
      const st = await state()
      const { lastRun } = await chrome.storage.local.get({ lastRun: null })
      const alarms = await chrome.alarms.getAll()
      const alarm = alarms.find((a) => a.name === ALARM)
      return {
        scheduled: alarm
          ? t('statusAlarm', alarm.periodInMinutes, new Date(alarm.scheduledTime).toLocaleTimeString())
          : t('statusNoAlarm'),
        configured: isConfigured(await load()),
        recorded: st.seen.length,
        consecutiveFailures: st.fails,
        lastSuccess: st.lastOkAt ? new Date(st.lastOkAt).toLocaleString() : null,
        lastRun,
      }
    },
  }
  const fn = handlers[msg.type]
  if (!fn) return false
  fn().then(
    (result) => respond({ ok: true, result }),
    (err) => respond({ ok: false, error: String(err.message ?? err) }),
  )
  return true
})

// ------------------------------------------------------------------------ poll

let inflight = null

export function poll() {
  // A manual click during a scheduled run should show that run's result rather
  // than be turned away — at short intervals the two overlap almost every time.
  inflight ??= runPoll()
    .then(async (result) => {
      await chrome.storage.local.set({ lastRun: { at: stamp(), result } })
      await report(result)
      return result
    })
    .catch(async (err) => {
      const error = String(err?.message ?? err)
      await chrome.storage.local.set({ lastRun: { at: stamp(), error } })
      await report({ error })
      throw err
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

const stamp = () => new Date().toLocaleTimeString()

async function runPoll() {
  const s = await load()
  if (!isConfigured(s)) {
    badge('!', '#9e9e9e')
    await recordOnce('warn', 'logNeedSetup')
    return { needsSetup: true }
  }
  let orders
  try {
    orders = await fetchOrders({ developerId: s.developerId, days: s.days })
  } catch (err) {
    return onFailure(s, String(err.message ?? err))
  }
  return onSuccess(s, orders)
}

async function onSuccess(s, all) {
  const st = await state()
  const terminal = all.filter((o) => TERMINAL_STATES.has(o.state))
  // `delivered` is the journal of a run that ended before it could fold its
  // keys into `seen`; those orders did reach the user and must not repeat.
  const seen = new Set([...st.seen, ...st.delivered])
  const epoch = resetEpoch

  const write = (extra) =>
    epoch === resetEpoch
      ? chrome.storage.local.set({ seen: [...seen].slice(-MAX_SEEN), delivered: [], ...extra })
      : Promise.resolve()

  const { batch, overflow, muted, freshCount, unseenCount } = plan(terminal, seen, s, MAX_MESSAGES)

  if (!st.bootstrapped) {
    // First run adopts what is already there. Announcing history would train the
    // user to ignore the channel on day one. Storing before sending is safe
    // precisely because nothing is announced.
    try {
      await sendTelegram(s.botToken, s.chatId, label(s, t('tgFirstSync', terminal.length, s.days)))
    } catch (err) {
      // Nothing was announced and nothing recorded, so the next poll simply
      // tries again rather than adopting history the user was never told about.
      return onFailure(s, delivery(err))
    }
    for (const o of terminal) seen.add(keyFor(o))
    await write({ bootstrapped: true, fails: 0, lastOkAt: Date.now() })
    await record('info', 'logFirstSync', terminal.length)
    badge('', '#4caf50')
    return { bootstrapped: terminal.length }
  }

  // Muted orders wait on no delivery, so they are banked straight away.
  for (const o of muted) seen.add(keyFor(o))
  await write()

  // A short journal of just this run's deliveries: writing it after every send
  // costs almost nothing, and a worker death loses at most the single order
  // whose send had already landed.
  const journal = []
  const note = (o) => {
    journal.push(keyFor(o))
    return epoch === resetEpoch
      ? chrome.storage.local.set({ delivered: journal })
      : Promise.resolve()
  }

  try {
    for (const o of batch) {
      await sendTelegram(s.botToken, s.chatId, describe(o, s))
      await record('order', 'logOrder', o.product || o.id, o.state)
      await note(o)
    }
    if (overflow.length) {
      await sendTelegram(s.botToken, s.chatId, label(s, t('tgMore', overflow.length)))
      // Only once that notice is out may the tail be written off. Banking it
      // first buried orders the user was never told existed.
      for (const o of overflow) await note(o)
    }
  } catch (err) {
    // A reset landed mid-run; recording failure state would re-dirty the slate
    // the user just cleared.
    if (epoch !== resetEpoch) return { aborted: 'reset' }
    return onFailure(s, delivery(err))
  }

  for (const key of journal) seen.add(key)
  await write({ fails: 0, lastOkAt: Date.now() })

  await record(
    'info',
    freshCount ? 'logCheckNew' : 'logCheckNone',
    freshCount || terminal.length,
    terminal.length,
  )

  // Informational and best-effort: losing this must not undo a run whose order
  // messages all landed.
  if (st.fails >= FAILS_BEFORE_ALERT) {
    await sendTelegram(s.botToken, s.chatId, label(s, t('tgRecovered'))).catch(() => {})
    await record('info', 'logRecovered')
  }

  badge(freshCount ? String(freshCount) : '', '#4caf50')
  return {
    new: freshCount,
    scanned: terminal.length,
    filtered: unseenCount - freshCount,
    pending: all.length - terminal.length,
  }
}

const DELIVERY_PREFIX = 'telegram: '
const delivery = (err) => `${DELIVERY_PREFIX}${String(err?.message ?? err)}`

async function onFailure(s, reason) {
  const st = await state()
  const fails = st.fails + 1
  const due = shouldAlert(fails, st.lastAlertAt)

  // lastOkAt deliberately not touched on a delivery failure: it is surfaced as
  // "last success", and a fresh timestamp there while nothing is reaching the
  // phone is worse than a stale one.
  await chrome.storage.local.set({ fails })
  badge('!', '#e53935')
  await record('error', 'logFail', reason, fails)

  // Quiet failure is the one thing this tool cannot do: a stopped checker looks
  // exactly like a quiet sales day.
  if (due) {
    const detail = reason === 'auth'
      ? t('tgFailAuth')
      : reason.startsWith(DELIVERY_PREFIX)
        ? t('tgFailDelivery', reason.slice(DELIVERY_PREFIX.length))
        : t('tgFailOther', reason)
    const text = `⚠️ ${t('tgFailHeader')}\n${detail}\n${t('tgFailCount', fails)}`
    const landed = await sendTelegram(s.botToken, s.chatId, label(s, text)).then(
      () => true,
      () => false,
    )
    // The cooldown starts when an alert actually arrives. Stamping it on the
    // attempt let a Telegram outage mute a later, unrelated failure for a day.
    if (landed) {
      await chrome.storage.local.set({ lastAlertAt: Date.now() })
      await record('warn', 'logAlert')
    }
  }
  return { failed: reason, fails }
}

// Off by default because it is noise once the pipeline is trusted, but while it
// is not, silence is indistinguishable from death.
async function report(outcome) {
  const s = await load()
  if (!s.verbose || !s.botToken || !s.chatId) return
  await sendTelegram(s.botToken, s.chatId, label(s, `⏱ ${stamp()}\n${JSON.stringify(outcome)}`)).catch(
    () => {},
  )
}

function badge(text, color) {
  chrome.action.setBadgeText({ text })
  chrome.action.setBadgeBackgroundColor({ color })
}
