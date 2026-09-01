// What the model is allowed to touch. Nearly all of it is a read of the tally
// that is already there, computing nothing — every figure below comes out of the
// same fold /today and the order footer are drawn from, so an answer given here
// and one volunteered under an order cannot disagree.
//
// The exception is read_expected, which is the only thing here that answers
// about a day that has not happened, and run_recount, which is the only thing
// here that writes. Both are argued for where they are defined. The rule that
// held for a long time — a wrong read is only a wrong sentence, a wrong write is
// a wrong ledger — is why /adjust is still not among them.
//
// Every figure is worked out in JS, never left to the model. It once added eight
// weeks of days itself and got three of them wrong, 5% over the range, which is
// how the grouping in read_totals came to be here rather than in the prompt.
import {
  startedAt, shift, sumRange, combine, weekStart, isDay, UNKNOWN_CURRENCY,
  KIND_BUY, KIND_SUB, KIND_RENEWAL,
  PERIOD_MONTHLY, PERIOD_NONE, UNKNOWN_PERIOD,
} from './totals.js'

// The kinds a question may name, in one list for the same reason PERIODS is one:
// the schema the model reads and the check that validates its answer have to
// offer exactly the same words.
const KINDS = [KIND_BUY, KIND_SUB, KIND_RENEWAL]
import { foldDays, readAll } from './orders.js'
import { expected as expectedFrom, recentRate, PERIODS } from './subs.js'
import { load, zoneOf } from './settings.js'

// What a range costs is the rows it emits, not the days it names — so that is
// what is capped. Three years asked for by day would be 1,100 rows and some
// 22,000 tokens, resent on every turn of the question; the same three years by
// month is 36 rows and 2,300 characters.
//
// So no range is ever refused. A span too wide for the grain asked for is
// answered at the next grain up, and the answer says which one it came back at.
// A refusal would only send the model round again to ask for less, and it has
// four turns to spend on the whole question.
export const MAX_ROWS = 62

// Coarsest last. Every step up divides the row count by roughly seven, twelve
// and thirty, so two steps cover anything this tally can hold.
export const GRAINS = ['day', 'week', 'month', 'year']

// Weeks start on Sunday because /week does, and a week the model reports and a
// week the command reports have to be the same seven days.
const startOfGroup = (day, grain) =>
  grain === 'week' ? weekStart(day)
    : grain === 'month' ? `${day.slice(0, 7)}-01`
      : grain === 'year' ? `${day.slice(0, 4)}-01-01`
        : day

function nextGroup(start, grain) {
  if (grain === 'day') return shift(start, 1)
  if (grain === 'week') return shift(start, 7)
  const [y, m] = start.split('-').map(Number)
  if (grain === 'month') return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
  return `${y + 1}-01-01`
}

// Walked rather than divided: a month is not a fixed number of days, and a week
// that starts before the range does still counts as one row.
function countGroups(first, last, grain) {
  let n = 0
  for (let g = startOfGroup(first, grain); g <= last; g = nextGroup(g, grain)) n += 1
  return n
}

// The finest grain that fits, starting from the one asked for. Never finer than
// asked: someone who wants months does not want days because they happen to fit.
function grainFor(first, last, want) {
  const from = Math.max(0, GRAINS.indexOf(want))
  for (let i = from; i < GRAINS.length; i += 1) {
    if (countGroups(first, last, GRAINS[i]) <= MAX_ROWS) return GRAINS[i]
  }
  return GRAINS[GRAINS.length - 1]
}

// Zeroes are dropped rather than printed. A row per day is what makes "which day
// sold nothing" answerable, but spelling out four zero fields on each of them
// buries the days that did sell in the days that did not.
function row(head, figures) {
  const out = { ...head, currency: figures.currency, amount: figures.amount, orders: figures.orders }
  if (!figures.currency) delete out.currency
  if (figures.refunds) out.refunds = figures.refunds
  if (figures.refunded) out.refunded = figures.refunded
  // The one field that must survive the trimming: it is the difference between a
  // day that earned this much and a day whose figure is short by an order nobody
  // could convert.
  if (figures.uncounted) out.uncounted = figures.uncounted
  return out
}

// Where a question's range actually lands, once the future and the days before
// counting began are taken off it. Shared by both reads below so the two can
// never disagree about what "the last two months" covers, and so the refusals
// they hand back read the same either way.
//
// Errors come back as a value rather than a throw: they are addressed to the
// model, which can act on "narrow the range" and cannot act on a stack trace.
function resolve(totals, adjustments, { from, to }, today) {
  // Said before the trim below, so the two refusals stay about different things.
  // Told "nothing has happened after today" for a range it simply wrote
  // backwards, the model's only move is to reach further back — which fails the
  // same way, until the turns run out on a question the ledger could answer.
  if (from > to) return { error: 'from must be on or before to' }
  // A range reaching into the future is trimmed rather than refused: "this week"
  // ends on Saturday, and the question is still about the days that have
  // happened.
  const last = to > today ? today : to
  if (from > last) return { error: `nothing has happened after ${today}` }
  // Days before the tally began are not zero days, they are days it has nothing
  // to say about. Reporting them as zero would let the model announce a drought
  // that was really just an install date.
  //
  // Taken from both stores. /adjust accepts any past day, so a correction can be
  // entered for a day earlier than anything this ever announced — and a floor
  // read off the announced days alone would hide it here while /today, /week and
  // /month all counted it.
  //
  // Filtered on being a real timestamp rather than on being non-null: a bucket
  // key that does not parse — "2026-00-15", which /adjust's shape check lets
  // through — comes back from startedAt as NaN, and new Date(NaN) throws rather
  // than returning anything. One such key in storage would otherwise take every
  // question down with a RangeError, and this file promises errors as values.
  const began = [startedAt(totals), startedAt(adjustments)].filter((at) => Number.isFinite(at))
  const since = began.length ? new Date(Math.min(...began)).toISOString().slice(0, 10) : null
  if (!since) return { since: null }
  return { since, first: from < since ? since : from, last }
}

// Announced orders plus hand-entered corrections, a row per day, week, month or
// year. The grain is the caller\'s to ask for and this function\'s to widen: what
// comes back always says which one it is.
export function rangeOf(totals, adjustments, { from, to, groupBy }, today) {
  if (!isDay(from) || !isDay(to)) {
    return { error: 'from and to must be real dates in YYYY-MM-DD form' }
  }
  if (groupBy != null && !GRAINS.includes(groupBy)) {
    return { error: `groupBy must be one of ${GRAINS.join(', ')}` }
  }
  const span = resolve(totals, adjustments, { from, to }, today)
  if (span.error) return span
  if (!span.since) return { since: null, rows: [], note: 'the tally has no days recorded yet' }
  const { since, first, last } = span
  // Chosen after the floor, so the grain follows the rows this will actually
  // emit rather than the years the question happened to name. "How did this year
  // go" against a fortnight-old install is a fortnight of days.
  const grain = grainFor(first, last, groupBy ?? 'day')

  const rows = []
  for (let g = startOfGroup(first, grain); g <= last; g = nextGroup(g, grain)) {
    // Clipped to the range at both ends, so a week reaching past today or back
    // before counting began is reported as the part of it that happened rather
    // than as a full week that came up short.
    const opens = g < first ? first : g
    const shuts = shift(nextGroup(g, grain), -1)
    const closes = shuts > last ? last : shuts
    const figures = combine(
      sumRange(totals, opens, closes),
      sumRange(adjustments, opens, closes),
    )
    rows.push(row(grain === 'day' ? { day: opens } : { from: opens, to: closes }, figures))
  }
  return {
    since,
    groupedBy: grain,
    // Said only when it differs from what was asked for, because a note under
    // every answer is noise — and this one has to be read when it appears.
    ...(groupBy && groupBy !== grain
      ? { note: `${groupBy} would have been more than ${MAX_ROWS} rows, so this is by ${grain}` }
      : {}),
    rows,
  }
}

// There is no "these days predate the split" gap here any more, and no field
// reporting one. A day is folded out of the orders on the way to being read, so
// every day this can see carries every split — which is the point of keeping the
// orders rather than a running total: a question nobody had thought of yet is
// answerable over all of history the moment it is written.
//
// The same money as above, dealt into piles: by the currency the buyer paid in,
// or by what kind of sale it was. Over any span at all — no day cap here,
// because the answer is one row per pile rather than one per day, so a question
// about the whole history costs the same handful of lines as one about last
// week. That is what lets "total revenue in INR" and "how many renewals in
// August" each be answered in a single call.
//
// The amounts are in the developer's payout currency, whichever split is asked
// for. They are the very numbers the daily totals are made of, only sorted — so
// a row and the day figures it came out of can never disagree, and nothing here
// is converted a second time.
//
// One function for both because the two splits are the same shape and the same
// arithmetic; a second copy of this is how one of them would start reporting a
// correction, or a gap, that the other did not.
function splitBy({ field, rows: label, row: one }, totals, adjustments, { from, to } = {}, today) {
  // Both ends optional, and both default to the widest honest answer: omitted,
  // the question is "all of it", which is the common one and should not cost the
  // model a turn spent guessing an install date it has not been told.
  if (from != null && !isDay(from)) return { error: 'from must be a real date in YYYY-MM-DD form' }
  if (to != null && !isDay(to)) return { error: 'to must be a real date in YYYY-MM-DD form' }
  // With no "to" given there is no ordering for the caller to have got wrong,
  // so a start date past today is the future, not a range written backwards.
  // Told "from must be on or before to" for a "to" it never supplied, the model
  // has nothing to correct.
  if (to == null && from != null && from > today) {
    return { error: `nothing has happened after ${today}` }
  }
  const span = resolve(totals, adjustments, { from: from ?? '0000-01-01', to: to ?? today }, today)
  if (span.error) return span
  if (!span.since) return { since: null, [label]: [], note: 'the tally has no days recorded yet' }
  const { since, first, last } = span

  const totalled = sumRange(totals, first, last)
  const corrected = sumRange(adjustments, first, last)
  const rows = Object.entries(totalled[field])
    .map(([name, c]) => {
      const out = { [one]: name, amount: c.amount, orders: c.orders }
      if (c.refunds) out.refunds = c.refunds
      if (c.refunded) out.refunded = c.refunded
      if (c.uncounted) out.uncounted = c.uncounted
      return out
    })
    // Biggest first: a question about a split is nearly always a question about
    // which parts of it matter, and the tail is the part that can be skimmed.
    .sort((a, b) => b.amount - a.amount)

  return {
    since,
    from: first,
    to: last,
    payoutCurrency: totalled.currency ?? corrected.currency ?? null,
    [label]: rows,
    // Hand-entered corrections belong to no buyer and to no kind of sale, so
    // they are named apart rather than folded into one of the rows. The rows
    // plus this is the day total; the rows alone are not.
    ...(corrected.amount ? { corrections: corrected.amount } : {}),
  }
}

// The plural names the list in the answer and the singular names the field in
// each row, spelled out rather than derived: "currencies" does not lose an "s"
// to become "currency", and a rule that works for one split and not the other is
// worse than two words.
export const byCurrency = (totals, adjustments, range, today) =>
  splitBy(
    { field: 'currencies', rows: 'currencies', row: 'currency' },
    totals, adjustments, range, today,
  )

// Two lists from one read, because the two questions are always asked together:
// "how many renewals" is nearly always followed by "how many of those are
// monthly", and a second round trip to find out costs a turn the question has
// only four of. Both are the same money dealt differently, so they add up to
// each other and to the day.
export function byKind(totals, adjustments, range, today) {
  const { period, kind } = range ?? {}
  if (period && !PERIODS.includes(period) && period !== PERIOD_NONE) {
    return { error: `period must be one of ${[...PERIODS, PERIOD_NONE].join(', ')}` }
  }
  if (kind && !KINDS.includes(kind)) {
    return { error: `kind must be one of ${KINDS.join(', ')}` }
  }
  const out = splitBy({ field: 'kinds', rows: 'kinds', row: 'kind' }, totals, adjustments, range, today)
  if (out.error || !out.kinds) return out
  const periods = splitBy({ field: 'periods', rows: 'periods', row: 'period' }, totals, adjustments, range, today)
  const plans = splitBy({ field: 'plans', rows: 'plans', row: 'plan' }, totals, adjustments, range, today)
  return {
    ...out,
    periods: periods.periods ?? [],
    // The two crossed, with the key taken apart again so a row reads as the two
    // facts it is rather than as a string the model has to parse.
    plans: (plans.plans ?? []).map(({ plan, ...row }) => {
      const [rowPeriod, rowKind] = String(plan).split(':')
      return { period: rowPeriod, kind: rowKind, ...row }
    }),
    // Asked for one corner of the cross, the answer is that corner — added up
    // here rather than picked out of five rows by the reader. Given the rows
    // alone a model answered "August monthly subscriptions" with the total for
    // every subscription, because both numbers were in front of it and only one
    // of them was the one asked for.
    ...(period || kind
      ? { matched: matching(plans.plans ?? [], period, kind) }
      : {}),
  }
}

// The rows of the cross that satisfy whichever halves were named, summed. The
// figure is the point: one number to quote, with the two facts that define it.
function matching(rows, wantPeriod, wantKind) {
  const out = { amount: 0, orders: 0, refunds: 0, refunded: 0, uncounted: 0 }
  if (wantPeriod) out.period = wantPeriod
  if (wantKind) out.kind = wantKind
  // Subscriptions whose period could not be worked out, because only one charge
  // of them is on record. Asked for the monthly ones, they are neither in nor
  // out — they might be monthly and nothing here can say. Named for the same
  // reason the projection names its own unknowns: told to quote `matched`, a
  // model would otherwise report a figure with an unmeasured pile beside it and
  // no sign that the pile exists.
  let unplaced = 0
  let unplacedOrders = 0
  for (const row of rows) {
    const [rowPeriod, rowKind] = String(row.plan).split(':')
    const kindFits = !wantKind || rowKind === wantKind
    if (wantPeriod && rowPeriod === UNKNOWN_PERIOD && kindFits
      && (rowKind === KIND_SUB || rowKind === KIND_RENEWAL)) {
      unplaced += row.amount ?? 0
      unplacedOrders += row.orders ?? 0
    }
    if (wantPeriod && rowPeriod !== wantPeriod) continue
    if (!kindFits) continue
    for (const field of ['amount', 'orders', 'refunds', 'refunded', 'uncounted']) {
      out[field] += row[field] ?? 0
    }
  }
  if (unplaced || unplacedOrders) {
    out.subscriptionsWithUnknownPeriod = { amount: unplaced, orders: unplacedOrders }
  }
  return out
}

const READ_TOTALS = {
  name: 'read_totals',
  description:
    "Totals from this bot's own tally over a range, oldest first, in \"rows\". " +
    'Built from the orders the bot announced, anything a /recount pulled in from Play, and ' +
    'corrections entered with /adjust. ' +
    'Set "groupBy" to day, week, month or year and each row is one of those — so a question ' +
    'about weekly or monthly figures is answered by asking for them here, NOT by adding days ' +
    'up yourself. Weeks start on Sunday. There is no limit on the range: ask for whatever ' +
    'was asked about. If the grain you chose would run past ' +
    String(MAX_ROWS) +
    ' rows the answer comes back at the next grain up, and "groupedBy" always says which ' +
    'grain it really is — read it before quoting anything. A row is {"day"} when grouped by ' +
    'day and {"from","to"} otherwise, clipped to the range, so the first and last row of a ' +
    'weekly answer may be part weeks. Fields, all omitted when zero: ' +
    '"amount" is the day\'s net in the developer\'s payout currency, with refunds ALREADY ' +
    'subtracted — never take "refunded" off it again. "orders" counts charges only. ' +
    '"refunds" counts reversals, which are not in "orders". "refunded" is what those ' +
    'reversals were worth and is negative, because the money went back out. ' +
    '"uncounted" is orders in a currency that could not be converted, so that day\'s ' +
    '"amount" is short by them and any figure quoted from it has to say so.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'First day of the range, YYYY-MM-DD' },
      to: { type: 'string', description: 'Last day of the range, YYYY-MM-DD' },
      groupBy: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year'],
        description: 'One row per day, week, month or year. Defaults to day.',
      },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
}

const READ_BY_CURRENCY = {
  name: 'read_by_currency',
  description:
    "This bot's own tally split by the currency the buyer paid in, one row per " +
    'currency, biggest first. Use this — not read_totals — for any question about a ' +
    'single currency, a country, or how the currencies compare. Both "from" and "to" are optional and ' +
    'default to the whole recorded history, so omit them for an all-time figure. ' +
    'Amounts are in "payoutCurrency", the developer\'s own — NOT in the row\'s currency, ' +
    'which only says who paid. Fields per row, omitted when zero except "currency" and ' +
    '"amount": "amount" is the net from that currency with refunds ALREADY subtracted; ' +
    '"orders" counts charges; "refunds" counts reversals; "refunded" is what they were ' +
    'worth, negative; "uncounted" is orders that could not be converted, so that row is ' +
    'short by them. A row with currency "' +
    UNKNOWN_CURRENCY +
    '" is orders whose buyer currency Play did not report. "corrections" is /adjust ' +
    'entries, which belong to no buyer and are in no row.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'First day of the range, YYYY-MM-DD. Omit for all time.' },
      to: { type: 'string', description: 'Last day of the range, YYYY-MM-DD. Omit for all time.' },
    },
    required: [],
    additionalProperties: false,
  },
}

// The one tool here that changes anything. It was read-only on purpose for a
// long time — a wrong read is a wrong sentence, a wrong write is a wrong ledger
// — and what changed is what a recount does. Since the orders themselves became
// the tally it merges by order id and never removes, so the worst a recount of
// the wrong month can do is fetch a span nobody asked about and put the same
// records back. /adjust is still not here: that one writes a figure of its own
// invention, and there is nothing to merge it against.
//
// Bounded to a day or a month, not because a year would break anything but
// because the model is holding a chat open while this runs. A year of Play
// requests outlives the question that asked for it.
// Days OF THE RANGE still to come — not days between now and its end. A range
// that has not started yet is the trap: asked about a single day at Christmas,
// counting from today gave a hundred and fourteen days of trade and answered
// with a hundred and fourteen days of money.
//
// Today is not one of them either: it is part-done and already inside
// chargedSoFar, so counting it again at a full day's rate bills the morning
// twice.
function daysLeft(from, to, today) {
  // The first day still to come: tomorrow, or the day the range opens if that is
  // later. Counted inclusively from there — a range wholly ahead has all of its
  // days left, including its first, and a single future day is one day and not
  // none.
  const opens = from > today ? from : shift(today, 1)
  if (to < opens) return 0
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${opens}T00:00:00Z`)) / 86_400_000) + 1
}

// What the range has already earned, scoped to the plan being asked about. Read
// off the crossed split rather than the day totals so that "monthly" means the
// monthly rows and not the whole day.
//
// With no period named it is every kind of sale, one-off purchases included —
// which is right for "what will September bring" and wrong for anything that
// says "subscriptions", so the two are handed back separately and the
// description says which is which. Nothing here decides for the reader.
//
// Corrections are added because /adjust belongs to no plan and so appears in
// none of the rows. Left out, this figure disagrees with read_totals over the
// very same days, and the model has two answers for one question.
function chargedIn(split, period) {
  const out = { amount: 0, uncounted: 0, subscriptions: 0 }
  if (!split || split.error || !split.plans) return out
  for (const row of split.plans) {
    const [rowPeriod, rowKind] = String(row.plan).split(':')
    if (period && rowPeriod !== period) continue
    out.amount += row.amount ?? 0
    out.uncounted += row.uncounted ?? 0
    if (rowKind === KIND_SUB || rowKind === KIND_RENEWAL) out.subscriptions += row.amount ?? 0
  }
  const corrections = split.corrections ?? 0
  // A correction belongs to no plan, so it lands in the total but not in the
  // subscription half — the same rule the splits themselves follow.
  if (!period) out.amount += corrections
  return out
}

const RUN_RECOUNT = {
  name: 'run_recount',
  description:
    'Fetch a span of orders from Play again and fold the tally back out of them, for when a ' +
    'figure looks wrong or a stretch was missed while the browser was closed. This CHANGES ' +
    'what every other tool reads, so call it only when asked to, never to check something. ' +
    'It merges by order id and removes nothing, so running it twice is the same as running ' +
    'it once. "period" is a month as YYYY-MM, a single day as YYYY-MM-DD, or a bare month ' +
    'number for this year. A year or the whole history is too long to run inside a chat: ' +
    'for those, say that the developer should type "/recount 2026" or "/recount" themselves. ' +
    'It answers with what it found, which you should pass on as it is.',
  parameters: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        description: 'YYYY-MM, YYYY-MM-DD, or a bare month number for this year.',
      },
    },
    required: ['period'],
    additionalProperties: false,
  },
}

const READ_EXPECTED = {
  name: 'read_expected',
  description:
    'What the subscriptions already recorded here are DUE to bill in a range, one row per ' +
    'billing period. This is the only tool that answers about days that have not happened; ' +
    'every other one reads what did. Use it for "what should next month bring", and set ' +
    '"period" to "' +
    PERIOD_MONTHLY +
    '" for a question about monthly renewals specifically. ' +
    'How it is worked out: each subscription\'s last charge plus its own billing period, ' +
    'at the amount that last charge was worth. Fields per row: "period" is ' +
    PERIODS.join(', ') + '; ' +
    '"subscriptions" is how many are due in the range; "amount" is what they would be worth ' +
    'in "payoutCurrency"; "uncounted" is any whose amount could not be converted, so the ' +
    'row is short by them. ' +
    'A month already under way is part fact and part projection, so both halves come back ' +
    'and you must pick the pair that matches the question. "chargedSoFar" is EVERYTHING the ' +
    'range has earned already — one-off purchases included — and "total" is that plus the ' +
    'projection: quote those two for a plain "what will this month bring". ' +
    '"chargedSoFarFromSubscriptions" and "totalFromSubscriptions" are the same two counting ' +
    'subscription charges only: quote THOSE whenever the question says subscriptions or ' +
    'renewals, or you will report every purchase of the month as subscription revenue. ' +
    '"stillDue" alone is only the renewals scheduled for the days that have not happened. ' +
    '"newSalesAtRecentRate" is the rest of the range at the daily rate the account has been ' +
    'trading over the window in "measuredOver" — purchases and new subscriptions, which have ' +
    'no due date to read and can only be estimated. It is the softest of the three and you ' +
    'must say which figures are which: what has been earned, what is scheduled, and what is ' +
    'a run rate. "total" is all three added. ' +
    '"chargedSoFarUncounted", when present, is orders that could ' +
    'not be converted, so say the figure is short by them. ' +
    'It CANNOT see cancellations, price changes or failed payments, so the projected half ' +
    'is a ceiling and ' +
    'not a forecast — the "assumes" field says so and you must pass that on in your answer, ' +
    'in the same breath as the figure rather than as a footnote. ' +
    '"subscriptionsWithUnknownPeriod" is subscriptions whose period could not be worked out ' +
    'because only one charge of them is on record; they are in no row, so the figure is ' +
    'short by whatever they would have billed. Say so when it appears.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'First day of the range, YYYY-MM-DD' },
      to: { type: 'string', description: 'Last day of the range, YYYY-MM-DD' },
      period: {
        type: 'string',
        enum: [...PERIODS],
        description: 'Only subscriptions billing on this period. Omit for all of them.',
      },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
}

// Read fresh on every call rather than handed in once. A question may take
// several turns, and a poll landing an order in the middle of one should be
// answered from what is in storage now, not from a copy taken before it arrived.
const READ_BY_KIND = {
  name: 'read_by_kind',
  description:
    "This bot's own tally split by what kind of sale each order was, one row per kind, " +
    'biggest first. Use this — not read_totals — for any question about subscriptions, ' +
    'renewals or one-off purchases, including how many there were. ' +
    'Both "from" and "to" are optional and default to the whole recorded history — omit BOTH ' +
    'for a question that names no period ("how many yearly subscriptions are there"), because ' +
    'a range guessed to be recent answers zero for anything older than the guess. Default ' +
    'history. The "kind" of a row is "' +
    KIND_RENEWAL +
    '" for a subscription charge after the first one, "' +
    KIND_SUB +
    '" for the charge that started a subscription, "' +
    KIND_BUY +
    '" for a one-off purchase, and "' +
    UNKNOWN_CURRENCY +
    '" for an order this could not place. Amounts are in "payoutCurrency", the ' +
    'developer\'s own. Fields per row, omitted when zero except "kind" and "amount": ' +
    '"amount" is the net from that kind with refunds ALREADY subtracted; "orders" counts ' +
    'charges — for renewals that IS the number of renewals; "refunds" counts reversals ' +
    'and is not in "orders"; "refunded" is what they were worth, negative; "uncounted" is ' +
    'orders that could not be converted, so that row is short by them. "corrections" is ' +
    '/adjust entries, which belong to no kind and are in no row. ' +
    'The same money is also dealt a second way in "periods", one row per billing period — ' +
    PERIODS.join(', ') + ', "' + PERIOD_NONE + '" for ' +
    'one-off purchases, and "' + UNKNOWN_PERIOD + '" for a subscription whose period could ' +
    'not be worked out ' +
    'because only one charge of it is on record. Same fields per row as above. Use it for ' +
    '"how much of this is monthly subscriptions"; for what is DUE rather than what happened, ' +
    'use read_expected. ' +
    'And a third time in "plans", which is those two crossed — one row per period AND kind, ' +
    'with "period" and "kind" fields of its own. THIS is the row to read for a question that ' +
    'names both, such as new monthly subscriptions or yearly renewals. Never take the amount ' +
    'from one list and the count from another: they are different groupings of the same money ' +
    'and the pair does not describe anything. ' +
    'BETTER STILL: pass "period" and/or "kind" as arguments and the answer comes back as ' +
    '"matched", one figure for exactly what you asked. "8월 월간 구독 수익" is period=' +
    PERIOD_MONTHLY + '; new monthly subscriptions is period=' + PERIOD_MONTHLY + ' with kind=' +
    KIND_SUB + '. Quote "matched", not a row you chose yourself. If "matched" carries ' +
    '"subscriptionsWithUnknownPeriod", that is subscription money whose period could not be ' +
    'worked out — only one charge of it is on record — so it is in no period row and the ' +
    'figure may be short by it. Say so.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'First day of the range, YYYY-MM-DD. Omit for all time.' },
      to: { type: 'string', description: 'Last day of the range, YYYY-MM-DD. Omit for all time.' },
      period: {
        type: 'string',
        enum: [...PERIODS, PERIOD_NONE],
        description: 'Narrow to one billing period. Say it here rather than picking a row.',
      },
      kind: {
        type: 'string',
        enum: [...KINDS],
        description: 'Narrow to one kind of sale. Say it here rather than picking a row.',
      },
    },
    required: [],
    additionalProperties: false,
  },
}

// Folded fresh on every call rather than handed in once. A question may take
// several turns, and a poll landing an order in the middle of one should be
// answered from what is in storage now, not from a copy taken before it arrived.
//
// The whole store, not a range: a question about one currency or one kind of
// sale has no range at all, and the model should not have to guess an install
// date to ask for. Three years of orders is under half a megabyte and folds in
// single-digit milliseconds, which is cheaper than the turn it would cost to
// find out how far back to look.
const stored = async () => {
  const settings = await load()
  const { adjustments, rates, payoutCurrency } = await chrome.storage.local.get({
    adjustments: {}, rates: {}, payoutCurrency: null,
  })
  const zone = zoneOf(settings)
  const orders = await readAll(zone)
  const fx = { currency: payoutCurrency, rates }
  // The orders themselves come back too. The day buckets cannot answer what is
  // due next: a projection needs the run of charges a subscription made, and
  // folding them into days is exactly the step that throws that away.
  return { totals: foldDays(orders, zone, fx), adjustments, orders, zone, fx }
}

// `recount` is handed in by background.js rather than imported. It is the one
// thing here that writes, and it lives beside the poll it shares a mutex with —
// importing it the other way round would be a cycle, and moving it here would
// put the write path in the file whose whole point is that it only reads.
export const tools = (today, { recount } = {}) => [
  {
    spec: READ_TOTALS,
    run: async (input) => {
      const { totals, adjustments } = await stored()
      return rangeOf(totals, adjustments, input ?? {}, today)
    },
  },
  {
    spec: READ_BY_CURRENCY,
    run: async (input) => {
      const { totals, adjustments } = await stored()
      return byCurrency(totals, adjustments, input ?? {}, today)
    },
  },
  {
    spec: READ_BY_KIND,
    run: async (input) => {
      const { totals, adjustments } = await stored()
      return byKind(totals, adjustments, input ?? {}, today)
    },
  },
  {
    spec: READ_EXPECTED,
    run: async (input) => {
      const { from, to, period } = input ?? {}
      if (!isDay(from) || !isDay(to)) {
        return { error: 'from and to must be real dates in YYYY-MM-DD form' }
      }
      if (from > to) return { error: 'from must be on or before to' }
      // Refused rather than filtered on. An off-list value — "Monthly", "month"
      // — matches no plan, so the projection would come back empty and read as
      // "nothing is due", which is a wrong answer where an error is the right
      // one. The sibling reads validate their inputs the same way.
      if (period && !PERIODS.includes(period)) {
        return { error: `period must be one of ${PERIODS.join(', ')}` }
      }
      const { orders, totals, adjustments, zone, fx } = await stored()
      const ahead = expectedFrom(orders, { from, to, period }, zone, fx, today)
      // A month already under way is part charged and part still to come, and
      // "what will September bring" wants both. Added here rather than left to
      // the model: it is one subtraction and one sum, and the last time this
      // tally left arithmetic to a model it came back 5% wrong.
      const closed = to < today ? to : today
      const so_far = from <= closed
        ? splitBy(
          { field: 'plans', rows: 'plans', row: 'plan' },
          totals, adjustments, { from, to: closed }, today,
        )
        : null
      const charged = chargedIn(so_far, period)
      const due = ahead.periods.reduce((n, r) => n + r.amount, 0)
      // What the rest of the range would take at the rate the account has been
      // trading. Only when the whole range is being asked about: narrowed to one
      // billing period the question is about subscriptions that exist, and a
      // run rate of new sales is not part of that answer.
      const rate = period ? null : recentRate(orders, zone, fx, today)
      const left = daysLeft(from, to, today)
      const newSales = rate && left > 0 ? Math.round(rate.perDay * left) : 0
      return {
        ...ahead,
        ...(rate && left > 0
          ? {
            newSalesAtRecentRate: {
              amount: newSales,
              daysRemaining: left,
              perDay: Math.round(rate.perDay),
              measuredOver: {
                from: rate.from, to: rate.to, days: rate.days,
                orders: rate.orders, amount: Math.round(rate.amount),
              },
            },
          }
          : {}),
        // Named apart so the model cannot report one as the other. The days
        // already counted are facts; only `stillDue` is the projection the
        // `assumes` line is about.
        chargedSoFar: charged.amount,
        chargedSoFarFromSubscriptions: charged.subscriptions,
        stillDue: due,
        total: charged.amount + due + newSales,
        totalFromSubscriptions: charged.subscriptions + due,
        // Orders in a currency that could not be converted, so both figures
        // above are short by them. Disclosed for the same reason every other
        // read in this file discloses it.
        ...(charged.uncounted ? { chargedSoFarUncounted: charged.uncounted } : {}),
      }
    },
  },
  // Offered only when a caller handed one in. The options-page test button asks
  // its question with no recount to give, and a tool the model can call and this
  // cannot run is worse than one it never sees.
  ...(recount ? [{ spec: RUN_RECOUNT, run: (input) => recount(input?.period ?? '') }] : []),
]
