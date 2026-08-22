import {
  send as sendTelegram, findChatId, updates as tgUpdates, chatsIn, publishCommands,
} from './telegram.js'
import { fetchOrders, keyFor } from './playconsole.js'
import { load, isConfigured } from './settings.js'
import { plan } from './filters.js'
import { describe, label, estimatedNet, totalLine } from './format.js'
import { ratesFrom, merge, payoutCurrency } from './fx.js'
import { record as tally, sum as sumTotals, trim as trimTotals, dayKey, monthKey } from './totals.js'
import { t } from './i18n.js'
import { shouldAlert, FAILS_BEFORE_ALERT } from './health.js'
import { record, recordOnce, clear as clearLog } from './log.js'

// pending is not an event, it is an order on its way to becoming one. Notifying
// on it means notifying twice — once pending, again when it settles, since the
// dedupe key carries state. Ignoring it entirely also keeps it out of `seen`, so
// the charge that follows still reads as new.
const TERMINAL_STATES = new Set(['charged', 'refunded'])

const ALARM = 'poll'
// Commands run on their own schedule. Waiting for the order poll meant asking
// /today and being answered up to ten minutes later, which is no answer at all.
// One minute is the floor chrome.alarms allows; the long poll below covers the
// gap, so the alarm is really just what restarts the wait.
const COMMANDS_ALARM = 'commands'
// Under the 30s idle window Chrome tears a service worker down in. Each pass
// through the loop opens with a chrome.storage read, which resets that timer,
// so waits chained at this length keep the worker alive where one long hold
// would have been killed mid-wait — silently, since the worker that would have
// logged it is the one that died.
const LONG_POLL_SECONDS = 25
// Roughly the alarm period, less the time one wait can overrun by. Stopping
// short of a full minute is what keeps a slow pass from colliding with the next
// alarm, which Telegram answers with 409.
const LISTEN_WINDOW_MS = 45_000
const MAX_SEEN = 5000
const MAX_MESSAGES = 10

const state = () =>
  chrome.storage.local.get({
    seen: [], delivered: [], bootstrapped: false, fails: 0, lastAlertAt: 0, lastOkAt: 0,
  })

// Every settled order carries the same money twice — the buyer's currency and
// the developer's — so the rate between them is learned from orders that have
// already arrived. Kept across runs because an unsettled order in a currency
// nothing settled in today would otherwise print in the buyer's.
async function exchange(all, epoch) {
  const { rates: stored, payoutCurrency: last } = await chrome.storage.local.get({
    rates: {}, payoutCurrency: null,
  })
  const rates = merge(stored, ratesFrom(all))
  const currency = payoutCurrency(all) ?? last
  // A reset means the user is pointing this at a different developer account.
  // Writing back what this in-flight fetch learned would restore that account's
  // currency and rates over the slate they just cleared.
  if (epoch === resetEpoch) await chrome.storage.local.set({ rates, payoutCurrency: currency })
  return { rates, currency }
}

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
  await chrome.alarms.clear(COMMANDS_ALARM)
  await chrome.alarms.create(COMMANDS_ALARM, { periodInMinutes: 1, delayInMinutes: 0.5 })
  publishMenu().catch((err) => console.warn('[kaching] menu', err))
}

// Registered once per token. Telegram keeps the menu on its side, so repeating
// the call on every save would be a request that changes nothing — but a new
// token is a new bot, with no menu at all until it is told.
async function publishMenu() {
  const { botToken } = await load()
  if (!botToken) return
  const { menuFor } = await chrome.storage.local.get({ menuFor: null })
  if (menuFor === botToken) return
  await publishCommands(botToken)
  await chrome.storage.local.set({ menuFor: botToken })
  await record('info', 'logMenu')
}

chrome.alarms.onAlarm.addListener((alarm) => {
  // Neither alarm has anyone to reject to; an unhandled rejection would take the
  // worker down and stop the schedule silently.
  if (alarm.name === ALARM) {
    poll().catch((err) => console.warn('[kaching] poll failed', err))
  } else if (alarm.name === COMMANDS_ALARM) {
    listen().catch((err) => console.warn('[kaching] commands failed', err))
  }
})

// Telegram answers a second concurrent getUpdates with 409, so exactly one wait
// is ever open. A poll that overruns its minute simply keeps the slot until it
// returns, and the next alarm finds it busy and does nothing.
let answering = null

function listen() {
  answering ??= (async () => {
    const s = await load()
    if (!isConfigured(s)) return
    await answerCommands(s)
  })()
    .catch((err) => {
      // A chat convenience must never be able to take down the job people
      // installed this for, and the next alarm is a minute away regardless.
      console.warn('[kaching] commands', err)
    })
    .finally(() => {
      answering = null
    })
  return answering
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const handlers = {
    poll: () => poll(),
    rearm: () => rearm(),
    findChatId: async () => {
      const token = msg.botToken || (await load()).botToken
      // The command listener holds Telegram's single getUpdates slot most of the
      // time, and a second one is answered with 409 rather than a chat list. So
      // the server is asked, and what it cannot give is taken from what the
      // listener already banked — which is the whole reason that memory exists.
      // Only the collision is swallowed. A bad token has to keep reaching the
      // page, which turns it into the one hint the user can act on.
      const live = await findChatId(token).catch((err) => {
        if (!/409|Conflict/.test(String(err?.message ?? err))) throw err
        return []
      })
      const { knownChats } = await chrome.storage.local.get({ knownChats: [] })
      return [...knownChats.filter((c) => !live.some((n) => n.id === c.id)), ...live]
    },
    test: async () => {
      const s = await load()
      if (!s.botToken || !s.chatId) throw new Error(t('msgNeedSetup'))
      return sendTelegram(s.botToken, s.chatId, label(s, t('tgConnected')))
    },
    reset: async () => {
      resetEpoch += 1
      // Learned rates and the payout currency go too: they describe a developer
      // account, and a reset is what someone does after pointing this at a
      // different one. Keeping them would convert the new account's money
      // through the old account's currency.
      await chrome.storage.local.set({
        seen: [], delivered: [], bootstrapped: false, fails: 0, lastAlertAt: 0,
        rates: {}, payoutCurrency: null, totals: {},
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

// Answers /today and /month from the same buckets the footer is drawn from, so
// the figure the chat reports on request can never disagree with one it already
// volunteered.
//
// Only ever reached once a chat id is configured: reading updates with an offset
// acknowledges them, and Telegram then drops them — which would eat the very
// message Find chat ID reads.
async function answerCommands(s) {
  const until = Date.now() + LISTEN_WINDOW_MS
  do {
    await waitForCommands(s)
  } while (Date.now() < until)
}

async function waitForCommands(s) {
  // The cursor is kept against the token that produced it: update ids run per
  // bot, so one left over from a previous bot would sit above everything the new
  // one will ever send, and every command would be skipped in silence.
  const stored = (await chrome.storage.local.get({ updateCursor: null })).updateCursor
  const from = stored?.token === s.botToken ? stored.at : 0

  const list = await tgUpdates(s.botToken, from, LONG_POLL_SECONDS)
  if (!list.length) return

  // Banked before anything else can fail: acknowledging these updates is what
  // takes them away from Find chat ID, so what they revealed has to survive here
  // instead.
  await rememberChats(chatsIn(list))

  const { totals } = await chrome.storage.local.get({ totals: {} })
  const today = dayKey(Date.now())
  // Only moves past what was actually dealt with. A reply lost to a 429 or a
  // dropped connection is left unacknowledged so the next poll tries again,
  // rather than being confirmed away unanswered and unlogged.
  let done = from
  for (const u of list) {
    const chat = u.message?.chat
    // Anyone can message a bot whose username they know. Only the configured
    // chat gets told what this account earns.
    // Anyone can message a bot whose username they know. Nothing to answer is
    // still something dealt with, so the cursor moves past it either way.
    const cmd =
      chat && String(chat.id) === String(s.chatId)
        ? // "/month@somebot" is what Telegram delivers in a group.
          String(u.message.text ?? '').trim().toLowerCase().split(/[@\s]/)[0]
        : ''
    const key = cmd === '/today' ? 'totalToday' : cmd === '/month' ? 'totalMonth' : null
    const reply = key
      ? totalLine(key, sumTotals(totals, key === 'totalToday' ? today : monthKey(today))) ??
        t(key, '—', 0)
      : cmd === '/start' || cmd === '/help'
        ? t('cmdHelp')
        : null
    if (reply) {
      // Only a reply that actually landed is logged as answered, and only then
      // is the command written off. The log is the one diagnostic surface here;
      // reporting a delivery that never happened is worse than saying nothing.
      const landed = await sendTelegram(s.botToken, s.chatId, label(s, reply)).then(
        () => true,
        () => false,
      )
      if (!landed) break
      await record('info', 'logAnswered', cmd)
    }
    done = u.update_id + 1
  }
  if (done > from) {
    await chrome.storage.local.set({ updateCursor: { token: s.botToken, at: done } })
  }
}

// A short list, newest last, of chats that have talked to this bot. It exists so
// Find chat ID still works after a poll has consumed the update that named them.
const MAX_CHATS = 20

async function rememberChats(seen) {
  if (!seen.length) return
  const { knownChats } = await chrome.storage.local.get({ knownChats: [] })
  const merged = [...knownChats.filter((c) => !seen.some((n) => n.id === c.id)), ...seen]
  await chrome.storage.local.set({ knownChats: merged.slice(-MAX_CHATS) })
}

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
  // Read off the whole fetch, not just what is being announced: a pending order
  // converts on the back of settled ones this run will never mention.
  const fx = await exchange(all, epoch)

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
  let buckets = (await chrome.storage.local.get({ totals: {} })).totals
  const note = (o) => {
    journal.push(keyFor(o))
    // Totals ride on the same write as the journal, so an order can never be
    // counted twice: whatever survives a worker death is exactly what was
    // already delivered.
    return epoch === resetEpoch
      ? chrome.storage.local.set({ delivered: journal, totals: buckets })
      : Promise.resolve()
  }

  // Counted before the message is rendered, so the footer includes the order it
  // is attached to. Muted orders are left out on purpose — a total the reader
  // cannot reconcile against the messages they were sent is worse than none.
  //
  // Filed under the day it is announced, not the day Play stamped it. The two
  // differ only for an order that surfaced late or crossed midnight, and filing
  // by the charge date would drop such an order out of the very footer attached
  // to it — a running tally the reader cannot follow line by line is no use to
  // them. It is a tally of what this told you, and says so.
  const count = (o) => {
    buckets = trimTotals(
      tally(buckets, dayKey(Date.now()), {
        net: estimatedNet(o, fx),
        refund: o.state === 'refunded',
        currency: fx.currency,
      }),
    )
  }

  try {
    for (const o of batch) {
      count(o)
      const footer = s.showDailyTotal
        ? totalLine('totalToday', sumTotals(buckets, dayKey(Date.now())))
        : null
      const text = [describe(o, s, fx), footer].filter(Boolean).join('\n')
      await sendTelegram(s.botToken, s.chatId, text)
      await record('order', 'logOrder', o.product || o.id, o.state)
      await note(o)
    }
    if (overflow.length) {
      await sendTelegram(s.botToken, s.chatId, label(s, t('tgMore', overflow.length)))
      // Only once that notice is out may the tail be written off. Banking it
      // first buried orders the user was never told existed.
      for (const o of overflow) {
        count(o)
        await note(o)
      }
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
