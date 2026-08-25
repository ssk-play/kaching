import {
  send as sendTelegram, findChatId, updates as tgUpdates, chatsIn, publishCommands,
} from './telegram.js'
import { fetchOrders, keyFor } from './playconsole.js'
import { load, isConfigured } from './settings.js'
import { plan } from './filters.js'
import { describe, label, estimatedNet, totalLine } from './format.js'
import { ratesFrom, merge, payoutCurrency } from './fx.js'
import {
  record as tally, sum as sumTotals, sumRange, trim as trimTotals,
  remember as rememberCharge, amountFor, startedAt, adjust, combine,
  dayKey, monthKey, weekStart, dayOf, DAY,
} from './totals.js'
import { ask, isQuestion, freshTurns, nextTurns } from './llm.js'
import { tools as ledgerTools } from './ledger.js'
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

// Registered once per bot-and-chat. Telegram keeps the menu on its side, so
// repeating the call on every save would be a request that changes nothing — but
// a new token is a new bot with no menu at all, and a new chat is a scope that
// has never been told.
//
// Single-flight for the same reason the log is worth reading: two saves a few
// hundred milliseconds apart would both find menuFor unset, and the log would
// report the same registration twice.
let publishing = null

function publishMenu() {
  publishing ??= registerMenu().finally(() => {
    publishing = null
  })
  return publishing
}

async function registerMenu() {
  const { botToken, chatId } = await load()
  if (!botToken || !chatId) return
  const key = `${botToken}:${chatId}`
  const { menuFor } = await chrome.storage.local.get({ menuFor: null })
  if (menuFor === key) return
  try {
    await publishCommands(botToken, chatId)
  } catch (err) {
    // Only reaching the worker console would leave the menu quietly absent with
    // nothing on the one surface anyone here checks to say why.
    await record('warn', 'logMenuFail', String(err?.message ?? err))
    return
  }
  await chrome.storage.local.set({ menuFor: key })
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
    // The same call a question from the chat makes, so what this proves is what
    // the chat will do — key, host, model and tool calling in one round trip.
    // Nothing is remembered from it: a probe is not a turn in anyone's
    // conversation, and it would otherwise be the context of the next one.
    testAi: async () => {
      const s = await load()
      if (!s.aiKey) throw new Error(t('msgNeedAiKey'))
      const today = dayKey(Date.now())
      return ask({
        apiKey: s.aiKey, baseUrl: s.aiBaseUrl, model: s.aiModel,
        question: t('cmdAiProbe'), today, tools: ledgerTools(today),
      })
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
        rates: {}, payoutCurrency: null, totals: {}, adjustments: {},
        counted: [], countedSince: 0, chatTurns: null,
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

  const { totals, adjustments } = await chrome.storage.local.get({ totals: {}, adjustments: {} })
  const today = dayKey(Date.now())
  // Only moves past what was actually dealt with. A reply lost to a 429 or a
  // dropped connection is left unacknowledged so the next poll tries again,
  // rather than being confirmed away unanswered and unlogged.
  let done = from
  for (const u of list) {
    const chat = u.message?.chat
    // Anyone can message a bot whose username they know. Only the configured chat
    // gets told what this account earns — and nothing to answer is still something
    // dealt with, so the cursor moves past it either way.
    const said = chat && String(chat.id) === String(s.chatId) ? String(u.message.text ?? '') : ''
    // "/month@somebot" is what Telegram delivers in a group, and /adjust and
    // /recount carry their arguments after the command itself.
    const [head = '', ...rest] = said.trim().split(/\s+/)
    const cmd = head.toLowerCase().split('@')[0]
    const arg = rest.join(' ')
    // hasOwn, not a bare lookup: "constructor" and "toString" are inherited keys
    // that answer truthy, and now that anything not a command is a question, a
    // sentence starting with one of those words would be swallowed by the totals
    // branch instead of being answered.
    const key = Object.hasOwn(SPANS, cmd) ? SPANS[cmd] : undefined
    const reply = key
      ? totalLine(key, spanOf(totals, adjustments, key, today)) ?? t(key, '—', 0)
      : cmd === '/adjust'
        ? await applyCorrection(arg)
        : cmd === '/recount'
          ? // A fetch of its own, so an expired Console session says so here
            // rather than answering with a silent zero.
            await recount(s, arg).catch((err) => t('tgFailOther', String(err?.message ?? err)))
          : cmd === '/start' || cmd === '/help'
            ? help(s)
            : null
    // Anything that is not one of the five is not a malformed command, it is a
    // sentence. Worked out after the chain rather than inside it because, alone
    // among the branches, what it answers is only worth remembering once the
    // reader has actually seen it.
    const asked = reply ? null : await answerQuestion(s, said)
    const text = reply ?? asked?.reply ?? null
    if (text) {
      // Only a reply that actually landed is logged as answered, and only then
      // is the command written off. The log is the one diagnostic surface here;
      // reporting a delivery that never happened is worse than saying nothing.
      const landed = await sendTelegram(s.botToken, s.chatId, label(s, text)).then(
        () => true,
        () => false,
      )
      if (!landed) break
      // A conversation that recorded a turn nobody saw would have the model
      // answer the next question as a follow-up to one that never happened.
      await asked?.remember?.()
      await record('info', 'logAnswered', cmd.startsWith('/') ? cmd : t('logAsked'))
    }
    done = u.update_id + 1
  }
  if (done > from) {
    await chrome.storage.local.set({ updateCursor: { token: s.botToken, at: done } })
  }
}

const SPANS = { '/today': 'totalToday', '/week': 'totalWeek', '/month': 'totalMonth' }

// A week straddles months, so it is a range where the other two are prefixes.
function span(buckets, key, today) {
  if (key === 'totalWeek') return sumRange(buckets, weekStart(today), today)
  return sumTotals(buckets, key === 'totalToday' ? today : monthKey(today))
}

// Announced orders plus hand-entered corrections. Every answer goes through this,
// so a correction cannot show up in one figure and not another.
const spanOf = (totals, adjustments, key, today) =>
  combine(span(totals, key, today), span(adjustments, key, today))

// Both commands take an optional day ahead of everything else, because a tally
// that cannot go back is no use on the day you notice it was wrong.
function dayArg(arg, today) {
  const parts = String(arg).trim().split(/\s+/).filter(Boolean)
  const day = DAY.test(parts[0] ?? '') ? parts.shift() : today
  // A day that has not happened cannot be corrected or recounted, and would leave
  // a bucket ahead of today rolling into the month.
  return day <= today ? { day, rest: parts.join(' ') } : null
}

// "+5000", "-6,500", "6500" — a bare figure reads as money coming in. Zero is
// turned away rather than acknowledged, since nothing about the total would move.
function signedAmount(text) {
  const cleaned = String(text).replace(/[,_\s]/g, '')
  if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) return null
  const amount = Number(cleaned)
  return Number.isFinite(amount) && amount !== 0 ? amount : null
}

const dayLine = (day, today, figures) =>
  day === today
    ? totalLine('totalToday', figures) ?? t('totalToday', '—', 0)
    : `${day} ${totalLine('totalDay', figures) ?? t('totalDay', '—', 0)}`

// The tally is written one message at a time and cannot go back: a refund already
// announced, or one this never saw at all, is money it has no other way of
// losing. So the reader can put it in by hand — either direction, any day.
//
// Written to its own store, never to the buckets. A poll in flight holds a copy of
// those and writes it back after every send, which would take a correction
// entered in the meantime straight back out.
async function applyCorrection(arg) {
  const today = dayKey(Date.now())
  const { totals, adjustments, payoutCurrency: paid } = await chrome.storage.local.get({
    totals: {}, adjustments: {}, payoutCurrency: null,
  })
  const asked = dayArg(arg, today)
  const amount = asked && signedAmount(asked.rest)
  const currency = totals[asked?.day]?.currency ?? adjustments[asked?.day]?.currency ?? paid
  if (!amount) return t('cmdAdjustUsage', currency ?? '—')

  const epoch = resetEpoch
  const next = adjust(adjustments, asked.day, { currency, amount })
  // Only reachable if the payout currency changed under a day already carrying a
  // correction; there is nothing sensible to add across the two.
  if (!next) return t('cmdAdjustUsage', adjustments[asked.day].currency)
  if (epoch === resetEpoch) await chrome.storage.local.set({ adjustments: trimTotals(next) })
  await record(
    'info', 'logAdjust', asked.day, `${amount > 0 ? '+' : ''}${amount} ${currency ?? ''}`.trim(),
  )
  return dayLine(asked.day, today, dayOf(totals, next, asked.day))
}

// Enough of a page that a day's worth of orders is not quietly truncated, and no
// further back than Play will answer for.
const RECOUNT_PAGE = 200
const RECOUNT_MAX_DAYS = 30

// Worked out from Play instead of read off the tally, for the same reason the
// correction exists: the tally never revisits what it already said.
//
// Filed by the day Play stamps the order rather than the day anything was
// announced, and a refund counts against that day — a day whose one order is a
// refund answers a negative figure, which is what it was. No ledger is consulted,
// so this works for days that predate one; that makes it a second opinion rather
// than a correction to /today, which answers what this told you.
async function recount(s, arg) {
  const today = dayKey(Date.now())
  const asked = dayArg(arg, today)
  const days =
    asked &&
    Math.ceil(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${asked.day}T00:00:00Z`)) / 86_400_000,
    ) + 2
  if (!asked || !(days <= RECOUNT_MAX_DAYS)) return t('cmdRecountUsage', RECOUNT_MAX_DAYS)

  const epoch = resetEpoch
  const all = await fetchOrders({ developerId: s.developerId, days, pageSize: RECOUNT_PAGE })
  const fx = await exchange(all, epoch)
  const st = await state()
  // Only what was announced. An order still on its way to the chat is counted
  // when it gets there, and including it here would have it land twice.
  const announced = new Set([...st.seen, ...st.delivered])

  let buckets = {}
  for (const o of all) {
    if (!TERMINAL_STATES.has(o.state) || dayKey(o.at) !== asked.day) continue
    if (!announced.has(keyFor(o))) continue
    buckets = tally(buckets, asked.day, {
      net: estimatedNet(o, fx),
      refund: o.state === 'refunded',
      currency: fx.currency,
    })
  }

  const figures = sumTotals(buckets, asked.day)
  const moved = await restate(asked.day, figures, epoch)
  await record('info', 'logRecount', asked.day, moved.note)

  const line = totalLine('totalRecount', figures) ?? t('totalRecount', '—', 0)
  const parts = [asked.day === today ? line : `${asked.day} ${line}`, moved.said]
  // A full page means Play had at least this many to give and may have had more;
  // a figure that might be missing orders has to say so.
  if (all.length >= RECOUNT_PAGE) parts.push(t('totalRecountCapped', RECOUNT_PAGE))
  return parts.filter(Boolean).join(' · ')
}

// The day is set to what Play says it was, and any correction entered by hand for
// it is dropped: a correction exists to patch a figure the tally got wrong, and
// there is nothing left to patch. Only the one day is touched.
//
// A day the recount found nothing for is reported and left alone. Zeroing a day on
// the strength of an empty answer is the one way this could destroy a figure it
// cannot rebuild.
//
// A poll in flight holds its own copy of the buckets and writes it back after
// every send, so it is waited out first — otherwise it would put the old figure
// straight back.
async function restate(day, figures, epoch) {
  if (!figures.orders && !figures.refunds) return { said: t('totalRecountUntouched'), note: '' }
  await inflight?.catch(() => {})
  if (epoch !== resetEpoch) return { said: t('totalRecountUntouched'), note: '' }

  const { totals, adjustments } = await chrome.storage.local.get({ totals: {}, adjustments: {} })
  const before = dayOf(totals, adjustments, day).amount
  const { [day]: dropped, ...rest } = adjustments
  await chrome.storage.local.set({
    totals: trimTotals({ ...totals, [day]: figures }),
    ...(dropped ? { adjustments: rest } : {}),
  })

  const amount = figures.amount - before
  if (!amount) return { said: t('totalRecountSame'), note: '0' }
  const signed = `${amount > 0 ? '+' : ''}${amount}`
  return { said: t('totalRecountMoved', signed), note: signed }
}

// A sentence, answered by a model on the user's own API key.
//
// No prefix to remember, because remembering one is the thing the command menu
// exists to avoid and a sentence has nowhere to put it.
//
// Only the configured chat is read at all. In a group that is still every
// message the bot is handed, and how many that is depends on settings this
// cannot see: Telegram's privacy mode, on by default, hands a bot only commands,
// @mentions and replies to its own messages — but it does not apply at all to a
// bot that has been made an administrator, and it can be turned off outright in
// @BotFather. So a group where either is true sends the whole conversation
// through here, on the owner's key. The private chat this was built for sends
// only what the owner types.
//
// The model reads the tally and cannot write to it, so the worst this can do is
// say something wrong — which the figures it is asked to quote alongside give
// the reader a way to catch. /recount and /adjust remain the only writers.
async function answerQuestion(s, said) {
  const question = said.trim()
  if (!isQuestion(question)) return null
  // Silence rather than a notice. With no key set this is simply a chat the bot
  // is not listening in on, and replying to every message with a setup prompt
  // would make it unusable as one.
  if (!s.aiKey) return null

  // One clock for both ends of the call. Read at the start and again at the end,
  // a conversation that was still current when its history was assembled could
  // be judged lapsed by the time the answer came back, and collapse to nothing
  // while the reader was mid-sentence.
  const now = Date.now()
  const today = dayKey(now)
  const epoch = resetEpoch
  // Stored as the two sentences rather than as the model's own message list: the
  // tool_use blocks in that list mean nothing without the results that answered
  // them, and a pair broken across a worker teardown is a request the API
  // rejects outright.
  const { chatTurns } = await chrome.storage.local.get({ chatTurns: null })
  try {
    const answer = await ask({
      apiKey: s.aiKey, baseUrl: s.aiBaseUrl, model: s.aiModel,
      question, today, tools: ledgerTools(today),
      history: freshTurns(chatTurns, now),
    })
    const next = nextTurns(chatTurns, now, question, answer)
    return {
      reply: answer,
      // Held back until the answer has landed, and dropped if the slate was
      // cleared while the model was still working — writing here would put the
      // cleared account's conversation back.
      remember: async () => {
        if (epoch === resetEpoch) await chrome.storage.local.set({ chatTurns: next })
      },
    }
  } catch (err) {
    // Said, but not remembered. Replayed as the assistant's own words on the next
    // question, "could not reach the API" would read to the model as something
    // it had once said about the tally.
    return { reply: t('tgFailOther', String(err?.message ?? err)) }
  }
}

// The five fixed commands are in the bot's own menu; what is not discoverable is
// that a sentence works too, and only once a key makes it work.
const help = (s) => (s.aiKey ? `${t('cmdHelp')} ${t('cmdHelpAsk')}` : t('cmdHelp'))

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

  // Read off the whole fetch, not just what is being announced: a pending order
  // converts on the back of settled ones this run will never mention. Read before
  // the split, because the minimum-payout filter is written in this currency.
  const fx = await exchange(all, epoch)

  const { batch, overflow, muted, freshCount, unseenCount } = plan(
    terminal, seen, s, MAX_MESSAGES, fx,
  )

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
    // Adopted, not counted — the totals start empty. Banked at zero so a refund
    // of any of this has a definite match to find and takes nothing back out,
    // rather than falling through to an estimate of money that never arrived.
    let adopted = []
    for (const o of terminal) {
      seen.add(keyFor(o))
      adopted = rememberCharge(adopted, o.id, { currency: fx.currency, amount: 0 })
    }
    await write({
      bootstrapped: true, fails: 0, lastOkAt: Date.now(),
      counted: adopted, countedSince: Date.now(),
    })
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
  const {
    totals: storedTotals, counted, countedSince, adjustments: corrections,
  } = await chrome.storage.local.get({
    totals: {}, counted: [], countedSince: 0, adjustments: {},
  })
  let buckets = storedTotals
  let charged = counted

  // The ledger arrived after the totals did, so an install that was already
  // counting has no entry for the charges it counted before. The oldest bucket is
  // the day counting started, which is what separates those from history that was
  // never counted at all.
  let since = countedSince
  if (!since) {
    since = startedAt(buckets) ?? Date.now()
    if (epoch === resetEpoch) await chrome.storage.local.set({ countedSince: since })
  }
  const note = (o) => {
    journal.push(keyFor(o))
    // Totals ride on the same write as the journal, so an order can never be
    // counted twice: whatever survives a worker death is exactly what was
    // already delivered.
    return epoch === resetEpoch
      ? chrome.storage.local.set({ delivered: journal, totals: buckets, counted: charged })
      : Promise.resolve()
  }

  // Whether an order's money actually reaches the amount rather than being
  // tallied as unconverted. Only that may be vouched for: remembering a charge
  // that added nothing would have its refund subtract a figure no bucket ever
  // received.
  const lands = (o) => {
    const net = estimatedNet(o, fx)
    return Boolean(net && fx.currency && net.currency === fx.currency)
  }

  // A page carries each order once, under whatever state it is in now, so a
  // charge and its own reversal normally arrive in different runs. Should one run
  // hold both, it has to net to zero whichever is reached first — and plan()
  // hands the overflow tail back newest-first — so this run's own charges count
  // as matches alongside the stored ones.
  const here = new Map(
    [...batch, ...overflow]
      .filter((o) => o.state !== 'refunded' && lands(o))
      .map((o) => [o.id, estimatedNet(o, fx).amount]),
  )

  // Exactly what the charge put in, negated. With no entry to go on — a charge
  // counted before the ledger existed — the estimate stands in, but only for a
  // charge from after counting started: older than that and nothing was ever
  // added for it to take back out.
  const reversal = (o) => {
    const added = amountFor(charged, o.id, fx.currency) ?? here.get(o.id) ?? null
    if (added != null) return { currency: fx.currency, amount: -added }
    return o.at >= since ? estimatedNet(o, fx) : null
  }

  // Counted before the message is rendered, so the footer includes the order it
  // is attached to. Muted orders are left out on purpose — a total the reader
  // cannot reconcile against the messages they were sent is worse than none.
  //
  // Filed under the day Play stamped the order, not the day it was announced. The
  // two differ only for an order that surfaced late or crossed midnight, and that
  // order does then miss the footer attached to it — but /recount answers by the
  // stamped day, and a figure that cannot be checked against Play is worth less
  // than one that misses a midnight straggler.
  //
  // A reversal may only take out what a charge put in, so a refund with no charge
  // to match is left out of the amount and disclosed as such: driving the day
  // negative for money the tally never saw arrive is the worse answer. The entry
  // is banked on the same write as the bucket it went into, so a run that dies
  // half-way cannot leave a charge vouched for that was never counted.
  const count = (o) => {
    const refund = o.state === 'refunded'
    const net = refund ? reversal(o) : estimatedNet(o, fx)
    if (!refund && lands(o)) charged = rememberCharge(charged, o.id, net)
    buckets = trimTotals(
      tally(buckets, dayKey(o.at), { net, refund, currency: fx.currency }),
    )
  }

  try {
    for (const o of batch) {
      count(o)
      const footer = s.showDailyTotal
        ? totalLine('totalToday', spanOf(buckets, corrections, 'totalToday', dayKey(Date.now())))
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
