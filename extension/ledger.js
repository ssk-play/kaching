// The one thing the model is allowed to touch: a read of the tally that is
// already there. It computes nothing — every figure below comes out of the same
// fold /today and the order footer are drawn from, so an answer given here and
// one volunteered under an order cannot disagree.
//
// Read-only on purpose. /recount and /adjust write, and a wrong write is a
// wrong ledger; a wrong read is only a wrong sentence, which the figures quoted
// beside it give the reader a way to catch.
import { dayOf, startedAt, shift, DAY } from './totals.js'

// Long enough for "the last two months", short enough that no single question
// can pull a year of days into the request. A wider question is answered by
// asking again, which the refusal below says.
export const MAX_RANGE_DAYS = 62

const MS_PER_DAY = 86_400_000

// Shape is not existence. "2026-04-31" satisfies any regex and parses as May
// 1st, so a range starting there would report a day that never happened and then
// step straight over the one that did. A key that survives the round trip
// through the same parse the loop walks with is a day; nothing else is.
const isDay = (key) => {
  if (!DAY.test(String(key))) return false
  try {
    return shift(key, 0) === key
  } catch {
    // Two thirds of the shape-valid keys — month 13, day 32 — do not parse at
    // all, and toISOString throws on them rather than returning anything.
    return false
  }
}

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

// Announced orders plus hand-entered corrections, day by day. Errors come back
// as a value rather than a throw: they are addressed to the model, which can act
// on "narrow the range" and cannot act on a stack trace.
export function rangeOf(totals, adjustments, { from, to }, today) {
  if (!isDay(from) || !isDay(to)) {
    return { error: 'from and to must be real dates in YYYY-MM-DD form' }
  }
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
  if (!since) return { since: null, days: [], note: 'the tally has no days recorded yet' }

  const first = from < since ? since : from
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

const READ_TOTALS = {
  name: 'read_totals',
  description:
    "Daily totals from this bot's own tally, one row per day in the range, oldest first. " +
    'Counts only orders the bot announced, plus corrections entered with /adjust, so it can ' +
    'differ from what Play reports. Fields, all omitted when zero except "day": ' +
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

// Read fresh on every call rather than handed in once. A question may take
// several turns, and a poll landing an order in the middle of one should be
// answered from what is in storage now, not from a copy taken before it arrived.
export const tools = (today) => [
  {
    spec: READ_TOTALS,
    run: async (input) => {
      const { totals, adjustments } = await chrome.storage.local.get({ totals: {}, adjustments: {} })
      return rangeOf(totals, adjustments, input ?? {}, today)
    },
  },
]
