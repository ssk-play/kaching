import {
  send as sendTelegram, findChatId, updates as tgUpdates, chatsIn, publishCommands, menuFingerprint,
  pause, BURST, PACE_MS,
} from './telegram.js'
import { fetchOrders, keyFor } from './playconsole.js'
import {
  load, isConfigured, zoneOf, deliveryDue, windowStart, normalizeAnchor, HOUR_MS,
} from './settings.js'
import { plan } from './filters.js'
import { describe, label, totalLine, isSettled, estimatedNet } from './format.js'
import { ratesFrom, merge, payoutCurrency } from './fx.js'
import {
  sum as sumTotals, sumRange, shift, trim as trimDays, MAX_DAYS as MAX_BUCKET_DAYS,
  adjust, combine, dayKey, startOf, endOf, monthKey, weekStart, dayOf, periodOf, DAY,
} from './totals.js'
import {
  foldDays, read as ordersRead, write as ordersWrite, countInto,
  forget as forgetOldOrders,
} from './orders.js'
import { ask, probe, summarize, compacted, isQuestion, freshTurns, nextTurns,
  DROPS_SYSTEM, DROPS_TOOLS } from './llm.js'
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

const state = () =>
  chrome.storage.local.get({
    seen: [], delivered: [], bootstrapped: false, fails: 0, lastAlertAt: 0, lastOkAt: 0,
    // When a batch last actually went out, and what settled while nothing was
    // going out. Both belong to the delivery pace rather than to a poll.
    lastDeliveryAt: 0, heldDrift: { moved: 0, by: 0 },
  })

// Play reports no net at all until it settles an order, so what a day counts for
// an unsettled one is an estimate off the price the buyer was charged — right
// for nearly every order, and wrong for one whose discount Google funds, where
// the buyer pays 400 and the developer banks 2,500.
//
// Nothing re-announces an order Play merely settled, so without this the day
// would carry the guess for good. It used to take a ledger of what each charge
// had added, a flag marking which of those were guesses, and a pass that moved
// the difference into the bucket by hand. Now the order is simply stored again
// and the day is folded from it — so all that is left to do is say so, because
// a day's figure that jumps with nothing to explain it is worse than a line
// nobody needed.
async function announceDrift(moved, by, settings) {
  if (!moved || !by) return
  const signed = `${by > 0 ? '+' : ''}${by}`
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
      // Before the question, whether this endpoint can carry one. A gateway that
      // forwards only the last user message answers everything with a 200 and a
      // paragraph, so the question below would come back looking like a pass —
      // fluent, in the right language, and about nothing that is in this tally.
      // Failing here names which half is missing; failing on the answer names
      // nothing, because the answer reads fine.
      const carries = await probe({ apiKey: s.aiKey, baseUrl: s.aiBaseUrl, model: s.aiModel })
      if (carries === DROPS_SYSTEM) throw new Error(t('msgAiDropsSystem'))
      if (carries === DROPS_TOOLS) throw new Error(t('msgAiDropsTools'))
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
        rates: {}, payoutCurrency: null, adjustments: {}, chatTurns: null, sweptOn: null,
        lastDeliveryAt: 0, heldDrift: { moved: 0, by: 0 },
      })
      // The orders themselves, which are the tally. Removed rather than blanked:
      // they are one key per month, and a month with nothing in it should not be
      // a key at all.
      const held = Object.keys(await chrome.storage.local.get(null))
      await chrome.storage.local.remove([
        ...held.filter((k) => k.startsWith('orders:')),
        // Written by versions that kept a running total and a charge ledger
        // beside it. Nothing reads them now, and leaving them would be a
        // megabyte of a cleared account still on disk.
        'totals', 'counted', 'countedSince',
      ])
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
      const s = await load()
      return {
        scheduled: alarm
          ? t('statusAlarm', alarm.periodInMinutes, new Date(alarm.scheduledTime).toLocaleTimeString())
          : t('statusNoAlarm'),
        // Said separately from the check interval because they are separate
        // clocks now, and the question "why has nothing arrived" has two
        // answers.
        delivery: deliveryLine(s, st.lastDeliveryAt),
        configured: isConfigured(s),
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

// What the delivery pace amounts to right now, in one line. Paused is said
// first: a paused install with a twelve-hour window is paused, and reporting the
// window would read as an explanation for silence that is going to outlast it.
//
// The time named is the next boundary, read in the zone the boundaries are
// counted from — the browser's own would print 09:00 as 01:00 for anyone whose
// tally runs on a different clock, which is the one number this line exists to
// give them.
function deliveryLine(s, lastDeliveryAt) {
  if (s.deliveryPaused) return t('statusPaused')
  const hours = Number(s.deliveryHours) || 0
  if (!s.deliveryScheduled || hours <= 0) return t('statusDeliveryNow')
  const at = normalizeAnchor(s.deliveryAnchor)
  const when = deliveryDue(s, lastDeliveryAt)
    ? t('statusDeliverySoon')
    : new Date(windowStart(s) + hours * HOUR_MS)
      .toLocaleTimeString(undefined, { timeZone: zoneOf(s) })
  // A day-long window has one boundary a day, and naming it twice — "every 24 h
  // from 05:00" — says less than "once a day at 05:00" does.
  return hours === 24
    ? t('statusDeliveryDaily', at, when)
    : t('statusDeliveryEvery', hours, at, when)
}

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

  const zone = zoneOf(s)
  const today = dayKey(Date.now(), zone)
  const { adjustments } = await chrome.storage.local.get({ adjustments: {} })
  const totals = await tallyOver(commandSpan(today), today, zone)
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

// The tally, folded out of the store for the days a question needs. There is no
// stored total to read: a day's figure is worked out from the orders every time
// it is asked for, which is what makes /today, the model's read and a /recount
// answers that cannot drift apart.
async function tallyOver(from, to, zone) {
  const { rates, payoutCurrency } = await chrome.storage.local.get({
    rates: {}, payoutCurrency: null,
  })
  return foldDays(await ordersRead(from, to, zone), zone, { currency: payoutCurrency, rates })
}

// The widest span any of the three fixed commands can ask about: this month, or
// the week that ran into it from the month before.
const commandSpan = (today) => {
  const first = `${monthKey(today)}-01`
  const week = weekStart(today)
  return week < first ? week : first
}

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
  const { adjustments, payoutCurrency: paid } = await chrome.storage.local.get({
    adjustments: {}, payoutCurrency: null,
  })
  const asked = dayArg(arg, today)
  const amount = asked && signedAmount(asked.rest)
  const currency = adjustments[asked?.day]?.currency ?? paid
  if (!amount) return t('cmdAdjustUsage', currency ?? '—')

  const epoch = resetEpoch
  const next = adjust(adjustments, asked.day, { currency, amount })
  // Only reachable if the payout currency changed under a day already carrying a
  // correction; there is nothing sensible to add across the two.
  if (!next) return t('cmdAdjustUsage', adjustments[asked.day].currency)
  if (epoch === resetEpoch) await chrome.storage.local.set({ adjustments: trimDays(next) })
  await record(
    'info', 'logAdjust', asked.day, `${amount > 0 ? '+' : ''}${amount} ${currency ?? ''}`.trim(),
  )
  const totals = await tallyOver(asked.day, asked.day, zone)
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

// Fetches a span from Play again and merges what comes back into the store.
//
// This used to rebuild each day's total from the orders it fetched and write
// that over the top, which made a truncated answer dangerous: a day handed back
// with half its orders would be restated at half its value. Whole days had to be
// declined by name, a poll in flight had to be waited out so it could not put
// the old figures straight back, and the charge ledger had to be rebuilt
// alongside so a later refund took out what this rebuild had counted.
//
// None of that survives storing the orders. Merging is by order id and never
// removes anything, so a page that came back short simply refreshes fewer
// orders than it might have. There is no figure to overwrite, because the
// figures are folded out of the store on the way to being read.
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
  // Days Play would not hand over whole even asked for on their own. Named in
  // the reply so a total that may be missing orders says which days they are —
  // but no longer dangerous, since nothing is being overwritten.
  const short = []
  // Filled in by the walk: how far back it actually got.
  const reached = {}
  const all = await ordersOver(s.developerId, zone, from, to, short, reached)
  const fx = await exchange(all, epoch)

  const wanted = all.filter((o) => {
    if (!TERMINAL_STATES.has(o.state)) return false
    const day = dayKey(o.at, zone)
    return day >= from && day <= to
  })

  // Read, written and read again under the one claim. A full-span recount spends
  // about two minutes fetching, which is several scheduled polls — and a poll
  // landing between the two reads would show up as a day this recount changed,
  // costing the reader an /adjust correction it never superseded.
  //
  // A reset landing while Play was answering is checked inside the claim too:
  // these orders belong to an account the user has just finished clearing, and
  // the check has to hold at the moment of the write rather than when it was
  // queued.
  const { was, adopted, now } = await claim(async () => {
    if (epoch !== resetEpoch) return {}
    const kept = await ordersRead(from, to, zone)
    const known = new Set(kept.map((o) => o.id))
    await ordersWrite(wanted, zone)
    return {
      was: foldDays(kept, zone, fx),
      adopted: wanted.filter((o) => !known.has(o.id)).length,
      now: foldDays(await ordersRead(from, to, zone), zone, fx),
    }
  })
  if (!now) return t('totalRecountUntouched')
  const figures = sumRange(now, from, to)
  const drift = figures.amount - sumRange(was, from, to).amount
  const changed = daysApart(was, now, from, to)

  // A correction entered by hand for a day this has just refreshed has nothing
  // left to patch: the day is now what Play says it is.
  if (changed.length) await dropCorrections(changed, epoch)

  const moved = changed.length
    ? t('totalRecountMovedDays', changed.length, `${drift > 0 ? '+' : ''}${drift}`)
    : t('totalRecountUntouched')
  await record('info', 'logRecount', from === to ? from : `${from}…${to}`, moved)

  const line = totalLine('totalRecount', figures) ?? t('totalRecount', '—', 0)
  const named =
    from === to
      ? from === today
        ? line
        : `${from} ${line}`
      : `${from}…${to} ${line}`
  const parts = [named, moved, adopted ? t('totalRecountAdopted', adopted) : '']
  // A figure that might be missing orders has to say so, and name the days it
  // could not read whole — there is nothing else the reader can do about them,
  // but a total quietly short by a day is worse than one that says which.
  if (short.length) parts.push(t('totalRecountCappedAt', RECOUNT_PAGE, short.sort().join(', ')))
  if (reached.day > from) parts.push(t('totalRecountReached', reached.day))
  return parts.filter(Boolean).join(' · ')
}

// Which days in the span hold a different figure than they did. Compared on the
// amount and the counts together, because an order replaced by one worth the
// same is still news the reply should not swallow.
function daysApart(was, now, from, to) {
  const out = []
  for (let day = from; day <= to; day = shift(day, 1)) {
    const a = sumTotals(was, day)
    const b = sumTotals(now, day)
    if (a.amount !== b.amount || a.orders !== b.orders || a.refunds !== b.refunds) out.push(day)
  }
  return out
}

async function dropCorrections(days, epoch) {
  const { adjustments } = await chrome.storage.local.get({ adjustments: {} })
  const next = { ...adjustments }
  let dropped = false
  for (const day of days) {
    if (day in next) {
      delete next[day]
      dropped = true
    }
  }
  if (dropped && epoch === resetEpoch) await chrome.storage.local.set({ adjustments: next })
}

// One writer at a time. chrome.storage has no transactions, so a poll and a
// recount merging into the same month chunk at once would each read it, each
// add their own orders, and the second write would drop the first's. Every
// write to the store goes through here.
let writing = Promise.resolve()
function claim(work) {
  const next = writing.then(work, work)
  writing = next.catch(() => {})
  return next
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
    // Named as what it is. This used to borrow the order-fetch wording, so a
    // model that timed out was reported as "could not read the orders" — which
    // sends the reader to their Play session, the one thing that was working.
    //
    // Said, but not remembered. Replayed as the assistant's own words on the next
    // question, "could not reach the API" would read to the model as something
    // it had once said about the tally.
    return { reply: t('cmdAiFailed', String(err?.message ?? err)) }
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

// A rebuild and a poll no longer contend for the books, because there are no
// books to overwrite: both merge orders into the store by id, and merging is
// idempotent. What they still contend for is the month chunk itself, which is
// read and written whole — so every write goes through claim() above, and this
// only has to keep one poll in flight at a time.
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

  const { batch, muted, freshCount, unseenCount } = plan(terminal, seen, s, fx)

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
    // Adopted, and counted. History used to be banked at zero so day one would
    // not open with money the chat had never mentioned — which left /today
    // disagreeing with a /recount of the same day for as long as the install
    // lived. Now the store is the tally, so what is kept is what is counted:
    // these orders happened, the reader simply is not told about them one by one.
    for (const o of terminal) seen.add(keyFor(o))
    await claim(() => (epoch === resetEpoch ? ordersWrite(terminal, zone) : null))
    await write({ bootstrapped: true, fails: 0, lastOkAt: Date.now() })
    await record('info', 'logFirstSync', terminal.length)
    badge('', '#4caf50')
    return { bootstrapped: terminal.length }
  }

  const today = dayKey(Date.now(), zone)

  // Muted orders wait on no delivery, so they are banked straight away.
  for (const o of muted) seen.add(keyFor(o))
  await write()

  // Everything Play returned goes into the store, whether it is about to be
  // announced or not — including the orders a filter muted. The tally is a fold
  // over the store, so this is what counting is now, and the alternative is a
  // /today that disagrees with a /recount of the same day about orders the
  // filter hid. A muted order is one the reader chose not to be told about, not
  // one that did not happen.
  //
  // Over the days this fetch actually reaches, not just today: Play settles an
  // order days after it was charged, and a window scoped to today would never
  // see the one case this exists for.
  const stamped = terminal.map((o) => dayKey(o.at, zone)).sort()
  const spanFrom = stamped[0] && stamped[0] < today ? stamped[0] : today
  const spanTo = stamped.at(-1) > today ? stamped.at(-1) : today
  const kept = await ordersRead(spanFrom, spanTo, zone)

  // Orders Play had not settled when they were last stored and has settled now,
  // and what those orders alone moved by. Read off the two versions rather than
  // off the day's total: a run that also announced a new order would otherwise
  // report that order's money as settlement drift, and the notice would be
  // wrong on exactly the runs where something did settle.
  const was = new Map(kept.map((o) => [o.id, o]))
  let settled = 0
  let drift = 0
  for (const o of terminal) {
    const old = was.get(o.id)
    if (!old || isSettled(old) || !isSettled(o)) continue
    const before_ = estimatedNet(old, fx)
    const after_ = estimatedNet(o, fx)
    if (!after_ || after_.currency !== fx.currency) continue
    settled += 1
    drift += after_.amount - (before_?.currency === fx.currency ? before_.amount : 0)
  }

  // The guard belongs inside the claim: checked when the work is queued, a reset
  // landing while the mutex is held would let this repopulate the very chunks
  // the reset had just removed.
  await claim(() => (epoch === resetEpoch ? ordersWrite(terminal, zone) : null))

  // Drift is read off the difference between what the store held and what this
  // fetch says, so it is only visible on the one run that writes it. Held back
  // with the orders it belongs to, it would simply be lost — the next run
  // compares the store against itself and sees nothing moved. So it accumulates
  // instead, and goes out with the batch it explains.
  const pendingDrift = { moved: st.heldDrift.moved + settled, by: st.heldDrift.by + drift }

  // Everything above this line happened: the orders are stored and the day is
  // counted. What the pace decides is only whether anyone is told yet.
  //
  // Nothing is added to `seen`, so the next run plans the same batch again, one
  // order longer. That is the queue — there is no second list to keep in step
  // with this one, and a worker that dies mid-hold loses nothing.
  if (!deliveryDue(s, st.lastDeliveryAt)) {
    await write({ fails: 0, lastOkAt: Date.now(), heldDrift: pendingDrift })
    await forgetOldOrders(today)
    // A failure alert is not an order. Someone who paused delivery asked for
    // quiet, not for the one thing this tool exists to prevent: a stopped
    // checker that looks exactly like a quiet sales day.
    await announceRecovery(s, st)
    if (freshCount) {
      await recordOnce('info', s.deliveryPaused ? 'logPaused' : 'logHeld', freshCount)
    }
    badge(freshCount ? String(freshCount) : '', '#f09000')
    return { held: freshCount, scanned: terminal.length, paused: s.deliveryPaused }
  }

  // A short journal of just this run's deliveries: writing it after every send
  // costs almost nothing, and a worker death loses at most the single order
  // whose send had already landed.
  const journal = []
  const { adjustments: corrections } = await chrome.storage.local.get({ adjustments: {} })
  const note = (o) => {
    journal.push(keyFor(o))
    return epoch === resetEpoch
      ? chrome.storage.local.set({ delivered: journal })
      : Promise.resolve()
  }

  // The running footer, folded in memory as the batch goes out. The orders are
  // already in the store, so this could be read back for every message — but
  // then every message in a batch would carry the same final figure, and the
  // point of the footer is what the day stood at when that order landed.
  //
  // Filed under the day Play stamped the order, not the day it was announced.
  // The two differ only for an order that surfaced late or crossed midnight, and
  // that order does then miss the footer attached to it — but /recount answers
  // by the stamped day, and a figure that cannot be checked against Play is
  // worth less than one that misses a midnight straggler.
  //
  // Folded from the store as it stood before this run's write, with the orders
  // about to be announced taken out. A run that stored an order and then failed
  // to send it leaves that order in the store and out of `seen`, so the next run
  // announces it — and a footer folded from the store as it stands would count
  // it once for being there and once for being announced.
  const announcing = new Set(batch.map((o) => o.id))
  let running = foldDays(kept.filter((o) => !announcing.has(o.id)), zone, fx)
  const footerFor = (o) => {
    running = countInto(running, o, zone, fx)
    return s.showDailyTotal
      ? totalLine('totalToday', spanOf(running, corrections, 'totalToday', today))
      : null
  }

  try {
    // Every fresh order, however many that is. A batch held for twelve hours is
    // a long batch by design, and slowing down once past a burst is what makes
    // that deliverable rather than something Telegram refuses partway through.
    for (const [i, o] of batch.entries()) {
      if (i >= BURST) await pause(PACE_MS)
      const text = [describe(o, s, fx), footerFor(o)].filter(Boolean).join('\n')
      await sendTelegram(s.botToken, s.chatId, text)
      await record('order', 'logOrder', o.product || o.id, o.state)
      await note(o)
    }
  } catch (err) {
    // A reset landed mid-run; recording failure state would re-dirty the slate
    // the user just cleared.
    if (epoch !== resetEpoch) return { aborted: 'reset' }
    return onFailure(s, delivery(err))
  }

  for (const key of journal) seen.add(key)
  // The window reopens from when a batch actually went out, not from every run
  // that was allowed to send: a quiet hour must not consume the wait the next
  // order is serving.
  const sent = journal.length > 0
  await write({
    fails: 0,
    lastOkAt: Date.now(),
    heldDrift: { moved: 0, by: 0 },
    ...(sent ? { lastDeliveryAt: Date.now() } : {}),
  })

  // Said once, after the batch, so it cannot be mistaken for one of the orders
  // just announced. Carries whatever settled while delivery was held, too —
  // that money is in the day's figure either way, and the line is what explains
  // the jump.
  await announceDrift(pendingDrift.moved, pendingDrift.by, s)
  // Months older than the tally can report on at all.
  await forgetOldOrders(today)

  await record(
    'info',
    freshCount ? 'logCheckNew' : 'logCheckNone',
    freshCount || terminal.length,
    terminal.length,
  )

  await announceRecovery(s, st)

  badge(freshCount ? String(freshCount) : '', '#4caf50')
  return {
    new: freshCount,
    scanned: terminal.length,
    filtered: unseenCount - freshCount,
    pending: all.length - terminal.length,
  }
}

// Informational and best-effort: losing this must not undo a run whose order
// messages all landed. Said on any run Play answered, held delivery included —
// the outage it closes was announced regardless of the pace.
async function announceRecovery(s, st) {
  if (!s.sayRecovered) return
  if (st.fails < FAILS_BEFORE_ALERT) return
  await sendTelegram(s.botToken, s.chatId, label(s, t('tgRecovered'))).catch(() => {})
  await record('info', 'logRecovered')
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
