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

  const measured = new Map()
  for (const [id, run] of runs) {
    run.sort((a, b) => a.at - b.at)
    // The most recent gap, not an average of them all. A subscription that moved
    // from monthly to yearly has both in its history, and only the last one says
    // what it will do next — which is the only thing anyone asks a period for.
    measured.set(id, run.length < 2
      ? UNKNOWN_PERIOD
      : periodForGap(gapDays(run[run.length - 2], run[run.length - 1])))
  }

  const byProduct = plansByProduct(runs, measured)
  const out = new Map()
  for (const [id, run] of runs) {
    const own = measured.get(id)
    // A plan belongs to the product, not to the buyer. Measured from this
    // subscription's own charges where there are two of them; otherwise taken
    // from what the same product's other subscribers are billed, which is the
    // same plan by definition.
    //
    // This is most of the answer, not a refinement of it. On a real account:
    // 150 subscriptions, 50 of them with a second charge to measure. Reading
    // each run alone left two thirds of the money as "period unknown" and a
    // month-ahead figure of 48,814 — with the product's own plan applied it is
    // 123,311, and the eight still unplaced are a yearly product that has not
    // had a year yet, which is honestly unknown.
    const product = productOf(run[0])
    const period = own === UNKNOWN_PERIOD
      ? (product && byProduct.get(product)) ?? own
      : own
    out.set(id, {
      id,
      period,
      // Whether this subscription's own charges said so, or its product's did.
      // The caveats downstream read differently for the two: a run that was
      // measured is a fact, and one that inherited is a plan the buyer is on.
      measured: own !== UNKNOWN_PERIOD,
      charges: run.length,
      last: run[run.length - 1],
    })
  }
  return out
}

// A subscription's product. Package and sku together, because two apps may sell
// a sku of the same name and they are not the same plan.
function productOf(order) {
  const pkg = order.packageName ?? ''
  const sku = order.sku ?? ''
  // Both halves or nothing. Play returns an empty string for either when it does
  // not report them, and a key of "|" would put every such subscription in one
  // bucket — handing a plan measured in one app to a subscriber of another.
  return pkg && sku ? `${pkg}|${sku}` : null
}

// What each product bills on, decided by its own subscriptions that could be
// measured. A product sells one plan per sku, so they should agree; where they
// do not — a plan whose period Play changed, a sku reused — the majority stands
// only if it is a large one, and otherwise the product is left unplaced rather
// than settled by a coin toss.
const AGREEMENT = 0.8
// And at least this many runs to agree. One is not a majority, it is an
// anecdote: a single failed payment that Play retried a week later reads as a
// weekly gap, and on a young sku that one run would be the only measured one —
// handing "weekly" to every subscriber of a monthly product and quadrupling the
// month ahead. Two observations is a thin guard and a real one.
const MIN_MEASURED = 2

function plansByProduct(runs, measured) {
  const votes = new Map()
  for (const [id, run] of runs) {
    const period = measured.get(id)
    if (period === UNKNOWN_PERIOD) continue
    const key = productOf(run[0])
    if (!key) continue
    const tally = votes.get(key) ?? new Map()
    tally.set(period, (tally.get(period) ?? 0) + 1)
    votes.set(key, tally)
  }

  const out = new Map()
  for (const [key, tally] of votes) {
    const counted = [...tally.values()].reduce((n, c) => n + c, 0)
    if (counted < MIN_MEASURED) continue
    const [period, top] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]
    if (top / counted >= AGREEMENT) out.set(key, period)
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
// New sales cannot be projected the way renewals can. A renewal is a charge
// already scheduled by a subscription that exists; a purchase next Tuesday is a
// stranger who has not arrived. There is no due date to read, so the only honest
// estimate is what the account has been taking lately, carried forward.
//
// A rate, not a trend. One-off purchases on the account this was built for went
// 548,126 in July and 1,056,819 in August — nearly double — and two points do
// not make a curve. Compounding that guess would put a number in front of the
// reader that the data cannot support; the recent daily rate is a figure they
// can check against the days it was measured over, which is why the window
// comes back with it.
export const RATE_WINDOW_DAYS = 28

export function recentRate(orders, zone, fx, today) {
  const wanted = shift(today, -RATE_WINDOW_DAYS)
  // Up to yesterday: today is part-done, and a half day drags the average down
  // by however much of it has not happened.
  const closes = shift(today, -1)
  // The window the store can actually answer for. A install three days old holds
  // three days of orders, and dividing those by twenty-eight reports a ninth of
  // the true rate — under a `measuredOver` line claiming four weeks of
  // observation that never happened.
  let earliest = null
  for (const o of orders) {
    const day = dayKey(o.at, zone)
    if (!earliest || day < earliest) earliest = day
  }
  const opens = earliest && earliest > wanted ? earliest : wanted
  const days = Math.max(1, Math.round(
    (Date.parse(`${closes}T00:00:00Z`) - Date.parse(`${opens}T00:00:00Z`)) / DAY_MS,
  ) + 1)
  let amount = 0
  let counted = 0
  for (const o of orders) {
    // Renewals are left out on purpose — they are projected from their own due
    // dates, and counting them here as well would bill every subscription twice.
    if (cycleOf(o) > 1) continue
    if (o.state !== 'charged' && o.state !== 'refunded') continue
    const day = dayKey(o.at, zone)
    if (day < opens || day > closes) continue
    const paid = estimatedNet(o, fx)
    if (!paid || paid.currency !== fx?.currency) continue
    amount += o.state === 'refunded' ? -Math.abs(paid.amount) : paid.amount
    counted += 1
  }
  return { from: opens, to: closes, days, orders: counted, amount, perDay: amount / days }
}

// How many subscriptions there are, and how many of them are still running.
//
// "Still running" is inferred, because Play does not report cancellations
// through this API at all — it reports charges. A subscription cancelled an hour
// after its last renewal is indistinguishable from one that will renew again,
// right up until the day it does not. So the narrower thing is what this says: a
// subscription counts as live while it has not yet missed its own next charge by
// half a period again, which is the very rule `expected` projects on. One rule,
// used twice, so the count of what is alive and the money it is expected to
// bill cannot come back disagreeing.
export function census(orders, zone, today, { period } = {}) {
  const subs = subscriptions(orders)
  const rows = new Map()
  const rowFor = (plan) => {
    if (!rows.has(plan)) {
      rows.set(plan, {
        period: plan,
        subscriptions: 0, live: 0, lapsed: 0, lastChargeRefunded: 0,
        measured: 0, inferred: 0,
      })
    }
    return rows.get(plan)
  }

  for (const sub of subs.values()) {
    const plan = sub.period
    if (period && plan !== period) continue
    const row = rowFor(plan)
    row.subscriptions += 1
    // A plan taken from the product rather than measured from this
    // subscription's own charges. Reported for the same reason `expected`
    // reports it: on a young account most of the rows lean on it.
    if (plan !== UNKNOWN_PERIOD) row[sub.measured ? 'measured' : 'inferred'] += 1

    if (daysApartKeys(dayKey(sub.last.at, zone), today) > lapsedAfter(plan)) {
      row.lapsed += 1
      continue
    }
    // Its most recent charge was handed back. Counted apart rather than as live:
    // a refund is usually where a subscription ends, and calling it running
    // would put a payer in the count who has just been made whole. Not called
    // lapsed either — Play may yet bill it again.
    if (sub.last.state === 'refunded') {
      row.lastChargeRefunded += 1
      continue
    }
    row.live += 1
  }

  const order = [...PERIODS, UNKNOWN_PERIOD]
  const periods = [...rows.values()].sort(
    (a, b) => order.indexOf(a.period) - order.indexOf(b.period),
  )
  const sum = (field) => periods.reduce((n, r) => n + r[field], 0)
  return {
    today,
    ...(period ? { period } : {}),
    periods,
    subscriptions: sum('subscriptions'),
    live: sum('live'),
    lapsed: sum('lapsed'),
    lastChargeRefunded: sum('lastChargeRefunded'),
    // The row keyed "?" is subscriptions charged once, of a product whose other
    // subscribers could not settle a plan either. They are in the totals and in
    // no named period, so a question about monthly plans may be short by them.
    assumes:
      'a cancellation is invisible until a charge fails to arrive, so "live" means '
      + 'not yet overdue, not confirmed active; it is a ceiling',
  }
}

export function expected(orders, { from, to, period } = {}, zone, fx, today) {
  const subs = subscriptions(orders)
  const rows = new Map()
  const currency = fx?.currency ?? null
  let unknown = 0
  let refunded = 0
  let lapsed = 0
  let inferred = 0
  let truncated = false

  for (const sub of subs.values()) {
    const { period: plan, last } = sub
    const lastDay = dayKey(last.at, zone)
    // Two different questions, and one measure cannot answer both.
    //
    // Is it still alive? Judged against today, never against the range. A
    // subscription that has missed its own next charge by a wide margin did not
    // renew, it stopped — and that is true whichever months are being asked
    // about. Measured against the range instead, a question reaching far enough
    // ahead called every live subscription stale and answered nothing.
    //
    // Against its OWN period, not against the longest plan Play sells. That flat
    // ceiling was tolerable while a subscription seen once was unknown and
    // therefore skipped; now that it inherits its product's plan, a monthly
    // subscriber last charged ten months ago would inherit "monthly", pass a
    // 380-day guard and be projected as revenue still to come.
    const idle = daysApartKeys(lastDay, today)
    if (idle > lapsedAfter(plan)) {
      lapsed += 1
      continue
    }
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

    if (!sub.measured) inferred += 1
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
    // Left out because they are past due by half a period again — Play would
    // have charged them by now. Named rather than dropped in silence: on a
    // shrinking account this is where the shrinking shows.
    ...(lapsed ? { subscriptionsLapsed: lapsed } : {}),
    // Counted with a plan taken from their product rather than measured from
    // their own charges, because they have only been charged once. The figure
    // leans on them — on a young account most of it does — and a reader who
    // thinks every period was observed is reading it as firmer than it is.
    ...(inferred ? { subscriptionsWithInferredPeriod: inferred } : {}),
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

// The longest plan in BANDS, with its own slack. Used only where no plan is
// known, which is the one case there is nothing better to measure against.
const LONGEST_PERIOD_DAYS = 380

// Roughly how long each plan runs, for judging whether one has lapsed.
const SPAN_DAYS = {
  [PERIOD_WEEKLY]: 7,
  [PERIOD_MONTHLY]: 31,
  [PERIOD_QUARTERLY]: 92,
  [PERIOD_YEARLY]: 366,
}

// Half a period past its due date and Play would have charged it, retried it, or
// given up. The slack is generous on purpose: a charge Play has not reported
// yet must not be read as a cancellation.
const lapsedAfter = (plan) => (SPAN_DAYS[plan] ?? LONGEST_PERIOD_DAYS) * 1.5
