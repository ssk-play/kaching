import {
  send as sendTelegram, findChatId, updates as tgUpdates, chatsIn, publishCommands, menuFingerprint,
} from './telegram.js'
import { fetchOrders, keyFor } from './playconsole.js'
import { load, isConfigured, zoneOf } from './settings.js'
import { plan } from './filters.js'
import { describe, label, estimatedNet, isSettled, totalLine, kindOf } from './format.js'
import { ratesFrom, merge, payoutCurrency } from './fx.js'
import {
  record as tally, sum as sumTotals, sumRange, trim as trimTotals, shift,
  MAX_DAYS as MAX_BUCKET_DAYS,
  remember as rememberCharge, amountFor, isEstimate, confirm as confirmCharge,
  resettle, startedAt, adjust, combine, UNKNOWN_CURRENCY,
  dayKey, startOf, endOf, monthKey, weekStart, dayOf, periodOf, DAY,
} from './totals.js'
import { ask, summarize, compacted, isQuestion, freshTurns, nextTurns } from './llm.js'
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

// An order Play has not settled yet is counted from an estimate: the price the
// buyer was charged, less the standard cut. That is the right guess for nearly
// every order and the wrong one for a discount Google funds, where the buyer is
// charged 400 and the developer banks 2,500 — the tally would keep the 400.
//
// Play fills the real figure in days later, under the same state, so nothing
// re-announces the order and nothing else would ever revisit it. This does: the
// charge ledger already remembers what each order put into the tally, so the
// difference is a subtraction, and the bucket is moved by it without being
// counted again.
//
// Only the amount moves. The reader was told about the order once, with the net
// marked as assumed, and telling them again would be an order that appears to
// have happened twice. What did move is said in one line, because a day's figure
// that jumps with nothing to explain it is worse than a line nobody needed.
async function putRight({ all, fx, seen, since, buckets, charged, epoch, settings }) {
  let totals = buckets
  let ledger = charged
  let moved = 0
  let drift = 0

  for (const o of all) {
    if (o.state !== 'charged' || !isSettled(o)) continue
    // Announced and counted, and counted from a guess. An entry written before
    // the flag existed reads as settled and is left to /recount.
    if (!seen.has(keyFor(o)) || !isEstimate(ledger, o.id)) continue
    // History adopted at first sync was banked at zero on purpose. Settling it
    // now would add money the tally deliberately never counted.
    if (o.at < since) continue
    const now = estimatedNet(o, fx)
    if (!now || now.currency !== fx.currency) continue
    const was = amountFor(ledger, o.id, fx.currency)
    if (was == null) continue

    // Confirmed whether or not the figure moved: what makes this cheap is that
    // an order is looked at once, not on every poll for as long as Play keeps
    // returning it.
    ledger = confirmCharge(ledger, o.id, now.amount)
    const by = now.amount - was
    if (!by) continue
    totals = resettle(
      totals,
      dayKey(o.at, zoneOf(settings)),
      { currency: o.net?.currency || UNKNOWN_CURRENCY, kind: kindOf(o) },
      by,
    )
    moved += 1
    drift += by
  }

  if (ledger === charged) return
  // A reset mid-poll means these buckets describe an account the user has just
  // finished clearing.
  if (epoch !== resetEpoch) return
  await chrome.storage.local.set({ totals: totals, counted: ledger })
  if (!moved) return

  const signed = `${drift > 0 ? '+' : ''}${drift}`
  await record('info', 'logSettled', moved, signed)
  // Best effort: a notice that did not land must not undo a correction that did.
  await sendTelegram(
    settings.botToken, settings.chatId, label(settings, t('tgSettled', moved, signed)),
  ).catch(() => {})
}

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
  // The menu itself is part of the key, not just who it was published to: a
  // build that adds a command has to reach installs that already registered the
  // old list, and nothing else would ever make it re-send.
  const key = `${botToken}:${chatId}:${menuFingerprint()}`
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
      const today = dayKey(Date.now(), zoneOf(s))
      // Whatever the page had in the box, then whatever was saved, then the
      // built-in probe. Someone chasing a wrong answer types the question that
      // produced it; someone who just wants to know the key works types nothing
      // and still gets a question that exercises a tool call rather than a
      // greeting the model could answer without reading anything.
      const question = msg.question || s.aiProbe || t('cmdAiProbe')
      return ask({
        apiKey: s.aiKey, baseUrl: s.aiBaseUrl, model: s.aiModel,
        question, today, tools: ledgerTools(today),
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
  const today = dayKey(Date.now(), zoneOf(s))
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
        ? await applyCorrection(arg, zoneOf(s))
        : cmd === '/recount'
          ? // A fetch of its own, so an expired Console session says so here
            // rather than answering with a silent zero.
            await recount(s, arg).catch((err) => t('tgFailOther', String(err?.message ?? err)))
          : cmd === '/compact'
            ? await compact(s)
            : cmd === '/start' || cmd === '/help'
              ? help(s)
              : null
    // Anything that is none of the above is not a malformed command, it is a
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
async function applyCorrection(arg, zone) {
  const today = dayKey(Date.now(), zone)
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
// As far back as the buckets themselves go. Beyond that there is nothing left to
// restate — trimTotals would drop the day again on the next write — so a wider
// request is refused rather than answered with days that will not survive.
// Whether Play still has anything that far back is Play's to say, and the walk
// reports where it actually stopped.
const RECOUNT_MAX_DAYS = MAX_BUCKET_DAYS
// How much of a span to ask for at once. Play does not answer a request for a
// year with fewer orders, it answers it with a 500, so the span is walked in
// pieces it will actually serve. Forty-five days is a guess at what is
// comfortable rather than a documented limit — which is why the walk below does
// not depend on it being right.
const RECOUNT_WINDOW_DAYS = 45

const daysBetween = (from, to) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1

// What a whole span may cost. Sequential requests, so this is a wait as much as
// a quota — and past it the answer is not "fetch harder" but "ask for less".
const RECOUNT_MAX_CALLS = 80

// One window's worth, halved and asked again whenever the answer cannot be
// trusted whole: a refusal means the window was too wide for Play, and a full
// page means the account was too busy for it. Both are the same remedy, and
// both are found by looking rather than by knowing a limit nobody publishes.
//
// A single day is where the halving stops. There is nothing left to narrow, so
// that day is reported as short rather than retried forever — and named in the
// reply, because the tally must not rewrite a day from part of it.
async function ordersWithin(developerId, zone, from, to, short, budget) {
  const span = daysBetween(from, to)
  let got = null
  if (budget.left <= 0) return []
  budget.left -= 1
  try {
    got = await fetchOrders({
      developerId,
      // The zone's own midnights, not UTC's. Play is asked for absolute time
      // and answers in it, so these two instants are what decide whether a day
      // comes back whole — ask for UTC midnight and file by Seoul's, and the
      // day is rebuilt from three quarters of itself.
      from: startOf(from, zone),
      to: endOf(to, zone),
      pageSize: RECOUNT_PAGE,
    })
  } catch (err) {
    // A rejected session is not a window that was too wide, and halving it
    // fourteen times would turn one honest error into a hundred.
    if (span <= 1 || /auth/.test(String(err?.message ?? err))) throw err
  }
  if (got && got.length < RECOUNT_PAGE) {
    // The widest window Play has actually served. Whatever it will take is not
    // documented, so it is learned once and the rest of the walk uses it rather
    // than rediscovering it by failing at every chunk.
    budget.window = Math.max(budget.window, span)
    // How far back the walk has genuinely got. Everything newer than this has
    // been asked for, because both this recursion and the loop below take the
    // newest piece first.
    if (!budget.oldest || from < budget.oldest) budget.oldest = from
    return got
  }
  if (span <= 1) {
    short.push(from)
    return got ?? []
  }
  // Newer half first, so a walk that runs out of requests has left off at a
  // clean edge with everything after it covered — rather than a hole in the
  // middle that no watermark can describe.
  const mid = shift(from, Math.floor(span / 2))
  return [
    ...(await ordersWithin(developerId, zone, mid, to, short, budget)),
    ...(await ordersWithin(developerId, zone, from, shift(mid, -1), short, budget)),
  ]
}

// Newest window first, so a span that runs out of requests loses its oldest days
// rather than its most recent ones — and loses them harmlessly, since a day the
// walk never reached is a day the rebuild finds nothing for, which restate
// leaves exactly as it was.
//
// Windows are disjoint by day, so no order is counted from two of them.
async function ordersOver(developerId, zone, from, to, short, reached) {
  const out = []
  const budget = { left: RECOUNT_MAX_CALLS, window: 0, oldest: null }
  let width = RECOUNT_WINDOW_DAYS
  for (let end = to; end >= from && budget.left > 0; ) {
    const back = shift(end, -(width - 1))
    const start = back < from ? from : back
    out.push(...(await ordersWithin(developerId, zone, start, end, short, budget)))
    if (budget.window) width = budget.window
    end = shift(start, -1)
  }
  // A day nobody asked Play about comes back empty, and restate leaves an empty
  // day exactly as it was — so stopping early loses nothing. It does have to be
  // said, though: a total that quietly covers half of what was asked for reads
  // like a business that halved.
  reached.day = budget.oldest ?? to
  return out
}

// Worked out from Play instead of read off the tally, for the same reason the
// correction exists: the tally never revisits what it already said.
//
// Filed by the day Play stamps the order rather than the day anything was
// announced, and a refund counts against that day — a day whose one order is a
// refund answers a negative figure, which is what it was. No ledger is consulted,
// so this works for days that predate one; that makes it a second opinion rather
// than a correction to /today, which answers what this told you.
const backTo = (day, today) =>
  Math.ceil((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000) + 2

// As far back as this is willing to fetch, and no further — the buckets have no
// say in it.
//
// They used to: "all" was clamped to the earliest day the tally already held,
// on the reasoning that a recount could only count what had been announced, so
// days before the first bucket had nothing to fill them with. Counting
// everything Play shows made that exactly backwards. Those days are the ones
// worth going to, and against an install whose buckets start today — which is
// every install that has just been set up, and the one case where "fetch it all"
// is really being asked — the clamp collapsed the whole span down to today and
// answered with the figure the reader already had.
const widestSpan = (today) => shift(today, -(RECOUNT_MAX_DAYS - 2))

async function recount(s, arg) {
  const zone = zoneOf(s)
  const today = dayKey(Date.now(), zone)
  const asked = periodOf(arg, today)
  if (!asked) return t('cmdRecountUsage', RECOUNT_MAX_DAYS)
  const from = asked.all ? widestSpan(today) : asked.from
  const to = asked.to
  const days = backTo(from, today)
  if (!(days <= RECOUNT_MAX_DAYS)) return t('cmdRecountUsage', RECOUNT_MAX_DAYS)

  const epoch = resetEpoch
  // Days Play would not hand over whole even asked for on their own. They are
  // left exactly as they were: a day rewritten from part of itself loses the
  // rest, and the "found nothing, leave it alone" rule does not cover a day that
  // came back with some of its orders.
  const short = []
  // Filled in by the walk: how far back it actually got.
  const reached = {}
  const all = await ordersOver(s.developerId, zone, from, to, short, reached)
  const fx = await exchange(all, epoch)
  const st = await state()
  const announced = new Set([...st.seen, ...st.delivered])

  const partial = new Set(short)

  // Everything Play still shows for these days, whether the chat was ever told
  // about it or not. The live tally can only count what it announced — it learns
  // of an order by announcing it — but this is the command for making the books
  // agree with Play, and history adopted at first sync is exactly what a reader
  // asking for "all of it" wants back.
  let buckets = {}
  let banked = new Map()
  let adopted = 0
  let first = null
  for (const o of all) {
    if (!TERMINAL_STATES.has(o.state)) continue
    const day = dayKey(o.at, zone)
    if (day < from || day > to || partial.has(day)) continue

    const paid = estimatedNet(o, fx)
    const spent = { net: paid, currency: fx.currency, from: o.net?.currency, kind: kindOf(o) }
    if (o.state === 'refunded') {
      // Play returns an order once, under the state it is in now, so a refunded
      // one arrives as the reversal alone. The charge it reverses happened too,
      // and on this same day — the tally files a reversal under the day of the
      // order, not the day of the refund. Counting only the minus would leave
      // the day short by a charge it did receive, and disagree with what /today
      // said at the time.
      const gross = paid && { currency: paid.currency, amount: -paid.amount }
      buckets = tally(buckets, day, { ...spent, net: gross, refund: false })
      buckets = tally(buckets, day, { ...spent, refund: true })
    } else {
      buckets = tally(buckets, day, { ...spent, refund: false })
      // What this rebuild says the charge put in, so a later reversal takes out
      // that and not whatever the tally happened to guess before.
      if (paid && paid.currency === fx.currency) {
        banked.set(o.id, { amount: paid.amount, estimated: !isSettled(o) })
      }
    }
    if (!announced.has(keyFor(o))) adopted += 1
    first = first == null || o.at < first ? o.at : first
  }

  const rebuilt = []
  for (let day = from; day <= to; day = shift(day, 1)) {
    if (partial.has(day)) continue
    rebuilt.push([day, sumTotals(buckets, day)])
  }
  const figures = sumRange(buckets, from, to)
  const moved = await restate(rebuilt, epoch, {
    banked, first, counted: all, currency: fx.currency, partial, from, to, zone,
  })
  await record('info', 'logRecount', from === to ? from : `${from}…${to}`, moved.note)

  const line = totalLine('totalRecount', figures) ?? t('totalRecount', '—', 0)
  const named =
    from === to
      ? from === today
        ? line
        : `${from} ${line}`
      : `${from}…${to} ${line}`
  const parts = [named, moved.said, adopted ? t('totalRecountAdopted', adopted) : '']
  // A figure that might be missing orders has to say so, and name the days it
  // declined to touch — there is nothing else the reader can do about them, but
  // a total quietly short by a day is worse than one that says which.
  if (short.length) parts.push(t('totalRecountCappedAt', RECOUNT_PAGE, short.sort().join(', ')))
  if (reached.day > from) parts.push(t('totalRecountReached', reached.day))
  return parts.filter(Boolean).join(' · ')
}

// Each day is set to what Play says it was, and any correction entered by hand
// for it is dropped: a correction exists to patch a figure the tally got wrong,
// and there is nothing left to patch. Only the days handed in are touched.
//
// A day the recount found nothing for is left alone, whether it was asked about
// on its own or as one of three hundred. Zeroing a day on the strength of an
// empty answer is the one way this could destroy a figure it cannot rebuild —
// and over a span, an answer truncated by the page limit is exactly what an
// empty day looks like.
//
// A poll in flight holds its own copy of the buckets and writes it back after
// every send, so it is waited out first — otherwise it would put the old figures
// straight back.
async function restate(rebuilt, epoch, rebuild) {
  const found = rebuilt.filter(([, figures]) => figures.orders || figures.refunds)
  if (!found.length) return { said: t('totalRecountUntouched'), note: '' }
  await inflight?.catch(() => {})
  if (epoch !== resetEpoch) return { said: t('totalRecountUntouched'), note: '' }

  const work = rewrite(found, rebuild)
  restating = work.finally(() => {
    restating = null
  })
  return work
}

// Kept apart from the waiting above so the claim on `restating` is made in the
// same tick the work starts in: an await between the two would be a gap a poll
// could start in, which is the whole thing being guarded against.
async function rewrite(found, rebuild) {
  const { totals, adjustments } = await chrome.storage.local.get({ totals: {}, adjustments: {} })
  const ledger = await rebank(rebuild)
  let nextTotals = totals
  let nextAdjustments = adjustments
  let delta = 0
  let moved = 0
  // Counted, because dropping one hand-entered correction is the documented
  // behaviour and dropping ninety of them in a single command is news.
  let cleared = 0
  for (const [day, figures] of found) {
    // Read against the stores as they were, not as this loop is leaving them.
    // Each day stands alone, so that is the same number either way — and saying
    // so here is cheaper than making the next reader work it out.
    const before = dayOf(totals, adjustments, day).amount
    nextTotals = { ...nextTotals, [day]: figures }
    if (Object.hasOwn(nextAdjustments, day)) {
      const { [day]: dropped, ...rest } = nextAdjustments
      nextAdjustments = rest
      cleared += 1
    }
    const amount = figures.amount - before
    if (amount) {
      delta += amount
      moved += 1
    }
  }
  await chrome.storage.local.set({
    totals: trimTotals(nextTotals),
    ...(nextAdjustments === adjustments ? {} : { adjustments: nextAdjustments }),
    ...ledger,
  })

  const undone = cleared ? t('totalRecountCleared', cleared) : ''
  if (!moved) return { said: [t('totalRecountSame'), undone].filter(Boolean).join(' · '), note: '0' }
  // Grouped like every other figure in the line. A full-span recount moves seven
  // digits, and "+1853572" beside "KRW 1,910,243" is the one number on the line
  // the reader has to count out by hand.
  const signed = `${delta > 0 ? '+' : ''}${delta.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  return {
    said: [
      moved === 1 ? t('totalRecountMoved', signed) : t('totalRecountMovedDays', moved, signed),
      undone,
    ]
      .filter(Boolean)
      .join(' · '),
    note: signed,
  }
}

// What the rebuild leaves behind besides the buckets.
//
// The charge ledger is what a reversal takes its figure from, so every charge
// this counted has to be in it at what it counted — an order adopted at zero on
// the day this was installed would otherwise be refunded for nothing at all.
// Entries the rebuild did not touch are kept: they are charges outside the span
// and still perfectly good.
//
// Counted orders are marked as already delivered, or the next poll would
// announce one of them and count it a second time on top of the day this just
// wrote. That does mean an order from the last few minutes can be counted here
// and never announced — the money is right and the notification is the thing
// given up, which is the trade an explicit "make it match Play" is worth.
async function rebank({ banked, first, counted, currency, partial, from, to, zone }) {
  const { counted: ledger, countedSince, seen, delivered } = await chrome.storage.local.get({
    counted: [], countedSince: 0, seen: [], delivered: [],
  })
  // Built through remember rather than as literals, so the entry shape — and
  // which field marks a figure Play has not settled yet — lives in one place.
  // The ids it would refuse as already known were dropped first, because a
  // rebuild replacing an entry is the whole point.
  let next = ledger.filter(([id]) => !banked.has(id))
  for (const [id, { amount, estimated }] of banked) {
    next = rememberCharge(next, id, { currency, amount, estimated })
  }
  const known = new Set([...seen, ...delivered])
  for (const o of counted) {
    if (!TERMINAL_STATES.has(o.state)) continue
    const day = dayKey(o.at, zone)
    if (day < from || day > to || partial.has(day)) continue
    known.add(keyFor(o))
  }
  return {
    counted: next,
    // Counting reaches back to the oldest order this took in, so a reversal of
    // one of them is a reversal of money the tally now holds rather than of
    // history it never saw.
    countedSince: first != null && (!countedSince || first < countedSince) ? first : countedSince,
    seen: [...known].slice(-MAX_SEEN),
    delivered: [],
  }
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
  const today = dayKey(now, zoneOf(s))
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

// Replaces the remembered conversation with a recap of it, so the thread
// survives at a fraction of what it was costing to carry.
//
// Not a cure for a context that grows: it cannot grow. Only the last
// MAX_TURNS_KEPT turns are ever resent, and a gap of HISTORY_TTL_MS drops them
// all, so a question has a ceiling on what it can cost whether or not anyone
// runs this. What it earns is the room under that ceiling — four turns of full
// answers replaced by a few lines means the next question carries the subject
// without carrying the prose, and a conversation can go on past four turns
// without the fifth losing the first.
//
// The recap is shown, not just kept. A summary the reader cannot see is one they
// cannot correct, and the next answer is built on it.
//
// The count is of live turns rather than stored ones. A lapsed conversation has
// nothing to compact, which is the truth — the model was never going to be shown
// it.
async function compact(s) {
  const now = Date.now()
  const epoch = resetEpoch
  const { chatTurns } = await chrome.storage.local.get({ chatTurns: null })
  const live = freshTurns(chatTurns, now)
  if (!live.length) return t('cmdCompactEmpty')

  // Writing a summary takes the same key as answering a question, so with no key
  // — or with the call refused — there is nothing to compact the turns into.
  // They are dropped rather than left: whoever typed this asked for a lighter
  // conversation, and forgetting is the one way of getting there that cannot
  // fail. Said plainly, because a thread the reader believes was summarised and
  // was actually forgotten is a next question asked into a void.
  const summary = s.aiKey
    ? await summarize({ apiKey: s.aiKey, baseUrl: s.aiBaseUrl, model: s.aiModel }, live)
        .catch(() => '')
    : ''

  // A reset mid-call means this conversation belongs to an account the user has
  // just cleared; writing either outcome back would restore it.
  if (epoch !== resetEpoch) return t('cmdCompactEmpty')
  await chrome.storage.local.set({ chatTurns: summary ? compacted(summary, now) : null })
  const one = live.length === 1
  if (!summary) return t(one ? 'cmdCompactDroppedOne' : 'cmdCompactDropped', live.length)
  return `${t(one ? 'cmdCompactDoneOne' : 'cmdCompactDone', live.length)}\n${summary}`
}

// The fixed commands are in the bot's own menu; what is not discoverable is
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

// A rebuild rewriting the books and a poll adding to them both work from a copy
// read out of storage, so whichever writes second wins outright. That is a
// millisecond of overlap for a poll landing one order — and a /recount of three
// years takes two minutes to fetch, which is long enough for a scheduled poll to
// start inside it. If the poll's copy of `seen` won, three hundred adopted
// orders would look unannounced again and the next check would send every one of
// them to the chat.
//
// So the two take turns. The rebuild waits for a poll in flight; a poll waits
// for a rebuild that has started writing. Both claims are made with no await in
// between, which is what makes taking turns work rather than just narrowing the
// window.
let restating = null

export function poll() {
  // A manual click during a scheduled run should show that run's result rather
  // than be turned away — at short intervals the two overlap almost every time.
  inflight ??= (restating ? restating.catch(() => {}) : Promise.resolve())
    .then(() => runPoll())
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
  const zone = zoneOf(s)
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
    // Flagged as a guess when Play has not settled it yet, so the pass below
    // knows which figures are still waiting on a real one.
    if (!refund && lands(o)) {
      charged = rememberCharge(charged, o.id, { ...net, estimated: !isSettled(o) })
    }
    buckets = trimTotals(
      tally(buckets, dayKey(o.at, zone), {
        net, refund, currency: fx.currency,
        // The currency the buyer actually paid in, which is the one a question
        // about a country's sales is really about. Read off the order even for a
        // reversal, where only the code is trustworthy.
        from: o.net?.currency,
        // And what kind of sale it was, so "how many renewals last month" is a
        // question the tally can answer rather than one it has to re-fetch Play
        // to guess at.
        kind: kindOf(o),
      }),
    )
  }

  try {
    for (const o of batch) {
      count(o)
      const footer = s.showDailyTotal
        ? totalLine('totalToday', spanOf(buckets, corrections, 'totalToday', dayKey(Date.now(), zone)))
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

  await putRight({ all, fx, seen, since, buckets, charged, epoch, settings: s })

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
    // The header carries no mark any more, so it has to carry the words. It used
    // to open with a warning sign and the product's own name; stripped of the
    // sign that left an outage announcing itself as "Kaching", indistinguishable
    // at a glance from the order messages around it in a busy chat — and an
    // alert scrolled past reads as a quiet sales day, which is the one thing
    // this path exists to prevent.
    //
    // It says something is broken, not which half: two of the three callers pass
    // delivery(), where Play was read perfectly well and only the send failed.
    // A header naming the read would send that reader to re-authenticate a
    // session that was never the problem.
    const text = `${t('tgFailHeader')}\n${detail}\n${t('tgFailCount', fails)}`
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
  await sendTelegram(s.botToken, s.chatId, label(s, `${stamp()}\n${JSON.stringify(outcome)}`)).catch(
    () => {},
  )
}

function badge(text, color) {
  chrome.action.setBadgeText({ text })
  chrome.action.setBadgeBackgroundColor({ color })
}
