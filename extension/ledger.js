// The one thing the model is allowed to touch: a read of the tally that is
// already there. It computes nothing — every figure below comes out of the same
// fold /today and the order footer are drawn from, so an answer given here and
// one volunteered under an order cannot disagree.
//
// Read-only on purpose. /recount and /adjust write, and a wrong write is a
// wrong ledger; a wrong read is only a wrong sentence, which the figures quoted
// beside it give the reader a way to catch.
import {
  dayOf, startedAt, shift, sumRange, hasBreakdown, hasKinds, isDay, UNKNOWN_CURRENCY,
  KIND_BUY, KIND_SUB, KIND_RENEWAL,
} from './totals.js'

// Long enough for "the last two months", short enough that no single question
// can pull a year of days into the request. A wider question is answered by
// asking again, which the refusal below says.
export const MAX_RANGE_DAYS = 62

const MS_PER_DAY = 86_400_000

const spanDays = (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY + 1

// Zeroes are dropped rather than printed. A row per day is what makes "which day
// sold nothing" answerable, but spelling out four zero fields on each of them
// buries the days that did sell in the days that did not.
function row(day, figures) {
  const out = { day, currency: figures.currency, amount: figures.amount, orders: figures.orders }
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

// Announced orders plus hand-entered corrections, day by day.
export function rangeOf(totals, adjustments, { from, to }, today) {
  if (!isDay(from) || !isDay(to)) {
    return { error: 'from and to must be real dates in YYYY-MM-DD form' }
  }
  const span = resolve(totals, adjustments, { from, to }, today)
  if (span.error) return span
  if (!span.since) return { since: null, days: [], note: 'the tally has no days recorded yet' }
  const { since, first, last } = span
  // Measured after the floor, so the cap counts the rows this would actually
  // emit rather than the years the question happened to name. "How did this year
  // go" against a fortnight-old install is a fortnight of rows, and refusing it
  // would cost a turn teaching the model a start date the refusal does not name.
  // A long-lived tally is still refused: there the floor moves nothing.
  const days = spanDays(first, last)
  if (days > MAX_RANGE_DAYS) {
    return { error: `that is ${days} days; ask for ${MAX_RANGE_DAYS} or fewer at a time` }
  }

  const out = []
  for (let day = first; day <= last; day = shift(day, 1)) {
    out.push(row(day, dayOf(totals, adjustments, day)))
  }
  return { since, days: out }
}

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
function splitBy({ field, rows: label, row: one, whole }, totals, adjustments, { from, to } = {}, today) {
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

  // Days recorded before this split existed. Their money is in the daily totals
  // and in none of the rows above, so a figure quoted from here without saying
  // so would read as a pile that earned nothing rather than as one this cannot
  // yet account for.
  const blind = Object.keys(totals).filter(
    (day) => day >= first && day <= last && !whole(totals[day]),
  ).length

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
    ...(blind
      ? {
          daysNotSplit: blind,
          note: `${blind} day(s) in this range were recorded before this split existed; their money is in the daily totals but in none of the rows above. A /recount of those days fills them in`,
        }
      : {}),
  }
}

// The plural names the list in the answer and the singular names the field in
// each row, spelled out rather than derived: "currencies" does not lose an "s"
// to become "currency", and a rule that works for one split and not the other is
// worse than two words.
export const byCurrency = (totals, adjustments, range, today) =>
  splitBy(
    { field: 'currencies', rows: 'currencies', row: 'currency', whole: hasBreakdown },
    totals, adjustments, range, today,
  )

export const byKind = (totals, adjustments, range, today) =>
  splitBy(
    { field: 'kinds', rows: 'kinds', row: 'kind', whole: hasKinds },
    totals, adjustments, range, today,
  )

const READ_TOTALS = {
  name: 'read_totals',
  description:
    "Daily totals from this bot's own tally, one row per day in the range, oldest first. " +
    'Built from the orders the bot announced, anything a /recount pulled in from Play, and ' +
    'corrections entered with /adjust. Fields, all omitted when zero except "day": ' +
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
    'single currency, a country, or how the currencies compare, and for a total over ' +
    'more than ' +
    String(MAX_RANGE_DAYS) +
    ' days: there is no limit on the range here. Both "from" and "to" are optional and ' +
    'default to the whole recorded history, so omit them for an all-time figure. ' +
    'Amounts are in "payoutCurrency", the developer\'s own — NOT in the row\'s currency, ' +
    'which only says who paid. Fields per row, omitted when zero except "currency" and ' +
    '"amount": "amount" is the net from that currency with refunds ALREADY subtracted; ' +
    '"orders" counts charges; "refunds" counts reversals; "refunded" is what they were ' +
    'worth, negative; "uncounted" is orders that could not be converted, so that row is ' +
    'short by them. A row with currency "' +
    UNKNOWN_CURRENCY +
    '" is orders whose buyer currency Play did not report. "corrections" is /adjust ' +
    'entries, which belong to no buyer and are in no row. If "daysNotSplit" is present, ' +
    'say the figure is incomplete and why.',
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

// Read fresh on every call rather than handed in once. A question may take
// several turns, and a poll landing an order in the middle of one should be
// answered from what is in storage now, not from a copy taken before it arrived.
const READ_BY_KIND = {
  name: 'read_by_kind',
  description:
    "This bot's own tally split by what kind of sale each order was, one row per kind, " +
    'biggest first. Use this — not read_totals — for any question about subscriptions, ' +
    'renewals or one-off purchases, including how many there were: there is no limit on ' +
    'the range here. Both "from" and "to" are optional and default to the whole recorded ' +
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
    '/adjust entries, which belong to no kind and are in no row. If "daysNotSplit" is ' +
    'present, say the figure is incomplete and why.',
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

const stored = () => chrome.storage.local.get({ totals: {}, adjustments: {} })

export const tools = (today) => [
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
]
