// How often a subscription bills, and what that says about the month ahead.
//
// Play does not tell us. The orders API reports that a charge belongs to a
// subscription — field 12, read in playconsole.js — and nothing about the plan
// behind it. There is no monthly-or-yearly flag to read, so asking for one and
// filing it away was never an option.
//
// What Play does give is an id. It appends "..N" to the base order id on every
// automatic renewal, so every charge of one subscription carries the same text
// before the dots and its own N after them. That makes the base id a
// subscription identifier, and the gap between two consecutive charges of the
// same base id the plan's own period — measured, not guessed.
//
// Which is why this lives here rather than in format.js beside kindOf. A single
// order cannot answer "monthly or yearly"; only the run of charges it belongs to
// can. Everything below therefore takes the whole store, and everything below
// says "unknown" rather than picking a likely answer when the store holds one
// charge of a subscription and no second one to measure against.
import {
  dayKey, shift,
  PERIOD_WEEKLY, PERIOD_MONTHLY, PERIOD_QUARTERLY, PERIOD_YEARLY, UNKNOWN_PERIOD,
} from './totals.js'
import { estimatedNet, cycleOf } from './format.js'

const DAY_MS = 86_400_000

// The base order id, which is the subscription. Everything from the first "..".
export const subIdOf = (order) => String(order.id ?? '').split('..')[0]

// Not "probably monthly". A subscription seen once has no gap to measure, and a
// gap that matches no plan is a plan this does not know — a retry after a failed
// charge, a Play-granted extension, or something Google offers that is not in
// the list below.

// The plans Play offers, with enough slack around each for a charge that landed
// a day or two off. The bands do not touch, so a gap between two of them stays
// unknown rather than being rounded into whichever is nearer — a 60-day gap is
// not a slow monthly, it is something this has no name for.
// Every plan this knows, in the order a reader would list them. Exported because
// the tool schema the model reads has to offer exactly these and no others, and
// a hand-typed enum beside a hand-typed band list is how the two drift apart.
export const PERIODS = [PERIOD_WEEKLY, PERIOD_MONTHLY, PERIOD_QUARTERLY, PERIOD_YEARLY]

const BANDS = [
  { period: PERIOD_WEEKLY, min: 5, max: 10 },
  { period: PERIOD_MONTHLY, min: 25, max: 35 },
  { period: PERIOD_QUARTERLY, min: 84, max: 98 },
  { period: PERIOD_YEARLY, min: 350, max: 380 },
]

// Days between two charges, rounded. Absolute time rather than day keys,
// because a subscription that bills at 23:50 and renews at 00:10 is a month
// apart to the minute and would be a day out if counted by calendar date.
const gapDays = (earlier, later) => Math.round((later.at - earlier.at) / DAY_MS)

export function periodForGap(days) {
  const band = BANDS.find((b) => days >= b.min && days <= b.max)
  return band ? band.period : UNKNOWN_PERIOD
}

// How long each period runs, for projecting the next charge forward. Months and
// years are stepped on the calendar rather than added as a fixed number of days
// — a monthly subscription charged on the 31st of January is not due on the 31st
// of February, and 30 days would drift a plan by five days a year.
export function nextDue(day, period) {
  const [y, m, d] = day.split('-').map(Number)
  if (period === PERIOD_WEEKLY) return shift(day, 7)
  if (period === PERIOD_MONTHLY) return addMonths(y, m, d, 1)
  if (period === PERIOD_QUARTERLY) return addMonths(y, m, d, 3)
  if (period === PERIOD_YEARLY) return addMonths(y, m, d, 12)
  return null
}

// The same day of a later month, pulled back to the last day of that month when
// it has no such date. The month-index arithmetic is orders.js `shiftMonth`
// again, and the clamp is what that one does not need — a chunk key has no day
// to lose. Kept apart rather than folded together for that reason; if a third
// caller ever wants the clamp, totals.js is where all three should live. Play does the same thing: a plan started on the 31st
// bills on the 30th in a thirty-day month and returns to the 31st after it.
function addMonths(y, m, d, by) {
  const n = y * 12 + (m - 1) + by
  const year = Math.floor(n / 12)
  const month = (n % 12) + 1
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const day = d > last ? last : d
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Every subscription in the store, with the plan it bills on and the charge it
// last billed. One pass, because this is called once per fold over the whole
// history and a scan per subscription would be quadratic in the same way the
// day map once was.
//
// Refunds are read alongside charges rather than skipped: a refunded renewal
// still happened, and its timestamp is still a point in the run that fixes the
// period. What a refund does change is whether the subscription is still worth
// projecting forward, which is settled in `expected` below.
export function subscriptions(orders) {
  const runs = new Map()
  for (const o of orders) {
    if (cycleOf(o) == null) continue
    const id = subIdOf(o)
    if (!runs.has(id)) runs.set(id, [])
    runs.get(id).push(o)
  }

  const out = new Map()
  for (const [id, run] of runs) {
    run.sort((a, b) => a.at - b.at)
    // The most recent gap, not an average of them all. A subscription that moved
    // from monthly to yearly has both in its history, and only the last one says
    // what it will do next — which is the only thing anyone asks a period for.
    const period = run.length < 2
      ? UNKNOWN_PERIOD
      : periodForGap(gapDays(run[run.length - 2], run[run.length - 1]))
    out.set(id, { id, period, charges: run.length, last: run[run.length - 1] })
  }
  return out
}

// A lookup from one order to its subscription's period, in the shape the fold
// wants. Built once per fold and handed down, because countInto sees one order
// at a time and the period is a property of the run, not of the order.
export function periodLookup(orders) {
  const subs = subscriptions(orders)
  return (order) =>
    (cycleOf(order) == null ? null : subs.get(subIdOf(order))?.period ?? UNKNOWN_PERIOD)
}

// What the subscriptions already in the store are due to bill between two days.
//
// Every figure here is a projection, and the shape says so rather than leaving
// the reader to infer it. A subscription is counted when its last charge plus
// its period lands inside the range, at the amount that last charge was worth —
// which assumes the price has not changed and, far more importantly, that
// nobody has cancelled.
//
// Cancellations are the thing this cannot see. Play tells us about charges that
// happened; a subscription that was cancelled the day after its last renewal
// looks exactly like one that will renew again, right up until the day it does
// not. So this is a ceiling, never a forecast, and `assumes` carries that into
// the answer so the model has to pass it on.
export function expected(orders, { from, to, period } = {}, zone, fx, today) {
  const subs = subscriptions(orders)
  const rows = new Map()
  const currency = fx?.currency ?? null
  let unknown = 0
  let refunded = 0
  let truncated = false

  for (const { period: plan, last } of subs.values()) {
    const lastDay = dayKey(last.at, zone)
    // Two different questions, and one measure cannot answer both.
    //
    // Is it still alive? Judged against today, never against the range. A
    // subscription that last billed longer ago than the longest plan Play sells
    // did not renew, it stopped — and that is true whichever months are being
    // asked about. Measured against the range instead, a question reaching far
    // enough ahead called every live subscription stale and answered nothing.
    if (daysApartKeys(lastDay, today) > LONGEST_PERIOD_DAYS) continue
    // Did it exist yet? Judged against the range. A subscription first charged
    // in August is not missing from a question about January.
    if (lastDay > to) continue

    // A refunded last charge is money that came back out. Projecting the next
    // one from it would forecast revenue from a subscription whose most recent
    // event was the buyer being made whole — but a batch of chargebacks would
    // then quietly shrink the figure, so it is counted and named rather than
    // dropped in silence. Only against the plan that was asked for: a monthly
    // reversal is no caveat on an answer about yearly plans.
    if (last.state === 'refunded') {
      if (!period || plan === period || plan === UNKNOWN_PERIOD) refunded += 1
      continue
    }
    // Counted whichever plan was asked for, because it might be that one — that
    // is what makes it a gap rather than a row.
    if (plan === UNKNOWN_PERIOD) {
      unknown += 1
      continue
    }
    if (period && plan !== period) continue

    const { days, hitGuard } = dueBetween(dayKey(last.at, zone), plan, from, to, today)
    truncated ||= hitGuard
    // Nothing due in the range. Counted nowhere: a subscription billing next
    // March is not part of what September brings, and adding it to the count
    // would have the model report renewals that are not coming.
    if (!days.length) continue

    const paid = estimatedNet(last, fx)
    const counted = Boolean(paid && currency && paid.currency === currency)
    const row = rows.get(plan) ?? { period: plan, charges: 0, subscriptions: 0, amount: 0, uncounted: 0 }
    row.subscriptions += 1
    for (const day of days) {
      void day
      row.charges += 1
      if (counted) row.amount += paid.amount
      else row.uncounted += 1
    }
    rows.set(plan, row)
  }

  return {
    from,
    to,
    payoutCurrency: currency,
    periods: [...rows.values()].sort((a, b) => b.amount - a.amount),
    // Named so the model cannot report the figure without the caveat attached
    // to it. Both halves matter: the ceiling, and how much of the store this
    // could not place.
    assumes: 'nobody cancels and no price changes; this is a ceiling, not a forecast',
    ...(unknown ? { subscriptionsWithUnknownPeriod: unknown } : {}),
    ...(refunded ? { subscriptionsSkippedAfterRefund: refunded } : {}),
    // A range so wide the walk stopped short of it. Said rather than left to
    // look like a complete answer — the whole point of the other two fields.
    ...(truncated ? { truncated: true } : {}),
  }
}

// Every day in the range this plan is due, walking forward from its last known
// charge. Bounded by the range rather than by a count, and stepped through the
// calendar so a monthly plan keeps its day of the month rather than drifting.
function dueBetween(lastDay, plan, from, to, today) {
  const days = []
  let day = nextDue(lastDay, plan)
  let guard = 0
  for (; day && day <= to; guard += 1) {
    if (guard >= MAX_STEPS) return { days, hitGuard: true }
    // Already in the past and no charge arrived for it. Play may simply not have
    // reported it yet, but counting it as expected revenue for a day that has
    // been and gone would put a figure in the answer that nothing will settle.
    if (day >= from && day > today) days.push(day)
    day = nextDue(day, plan)
  }
  return { days, hitGuard: false }
}

// A weekly plan over a decade is about 520 charges, which is far more than any
// real question. The guard is for a range asked for in error — and when it bites
// it is reported, because a walk that stopped early and a walk that finished
// look identical in the figure they produce.
const MAX_STEPS = 1000

// Whole days between two day keys, later minus earlier.
const daysApartKeys = (earlier, later) =>
  Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / DAY_MS)

// The longest plan in BANDS, with its own slack. Past this and a subscription
// that never billed a second time is not going to.
const LONGEST_PERIOD_DAYS = 380
