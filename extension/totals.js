// Running totals, kept as one bucket per day.
//
// Days rather than a single counter: a daily figure has to reset itself, and a
// monthly one has to be answerable months later without having been asked for
// in advance. Buckets give both from the same store.

// How far back the buckets keep anything, and so — since /recount cannot restate
// a day that will be trimmed off on the next write — how far back the books can
// reach at all.
//
// Three years. A day costs about 265 bytes once it carries its currency split,
// so the whole store is well under a megabyte against the ten chrome.storage
// .local gives, and the folds that answer /month walk it in no time. The old
// four hundred was set when a recount could only restate days the tally already
// had; once it could go and fetch history instead, that number stopped being a
// storage bound and started being the answer to "how much of my past can I
// have".
export const MAX_DAYS = 1100

// The developer's own day, not UTC. A sale at 08:00 in Seoul belongs to that
// morning; a UTC key would file it against the day before and make the daily
// figure disagree with the timestamp printed right above it.
export function dayKey(ms, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms))
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}

export const monthKey = (key) => key.slice(0, 7)

// The shape of a bucket key. Exported because the command parser and the ledger
// read both have to turn away a day they cannot look up, and two copies of this
// is how the two start disagreeing about what a day is.
export const DAY = /^\d{4}-\d{2}-\d{2}$/

// A key moved by whole days. Parsed as UTC for the same reason weekStart is: the
// key is already the developer's own calendar date, and re-reading it in local
// time would shift it for anyone west of Greenwich.
export const shift = (key, days) =>
  new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

// Shape is not existence. "2026-04-31" satisfies the regex above and parses as
// May 1st, so a range starting there would report a day that never happened and
// then step straight over the one that did. A key that survives the round trip
// through the same parse everything else walks with is a day; nothing else is.
export function isDay(key) {
  if (!DAY.test(String(key))) return false
  try {
    return shift(key, 0) === key
  } catch {
    // Two thirds of the shape-valid keys — month 13, day 32 — do not parse at
    // all, and toISOString throws on them rather than returning anything.
    return false
  }
}

// A stretch of days to work out again, written with the obvious parts left off.
//
//   (nothing)     everything still worth restating
//   today         today
//   20            the 20th of this month
//   08-20         the 20th of August this year
//   2026-08-20    that day
//   2026-08       that whole month
//   2026          that whole year
//   all           the same as nothing
//
// Bare is the whole lot because that is what someone typing a command called
// "fetch it again" is asking for. Today is one tap away as the day of the month,
// and by name for anyone who would rather not work out which day that is.
//
// What is missing is read off today, which is what makes the short forms worth
// having: the day someone wants to recount is nearly always in the month they
// are standing in. Whether a lone number is a day or a month is settled by its
// width — four digits is a year, one or two is a day — so nothing here has two
// readings, and "2026-08" is the only way to say a month.
//
// Deliberately not shared with /adjust. There a lone "20" is an amount, and a
// parser that read it as the twentieth would move a day nobody named.
const ALL = new Set(['all', '전체', '*'])
const TODAY = new Set(['today', '오늘'])

export function periodOf(text, today) {
  const raw = String(text ?? '').trim().toLowerCase()
  if (!raw || ALL.has(raw)) return { all: true, to: today }
  if (TODAY.has(raw)) return { from: today, to: today }
  if (!/^\d{1,4}(-\d{1,2}){0,2}$/.test(raw)) return null

  const parts = raw.split('-')
  const pad = (n) => String(n).padStart(2, '0')
  const [year, month] = [today.slice(0, 4), today.slice(5, 7)]

  // A year is written in full wherever it appears. "26-08-20" is a typo, not a
  // date in the first century, and reading it as one would fail much later with
  // a message about how far back Play goes.
  if (parts.length === 3 && parts[0].length !== 4) return null
  // Three parts is always a day; two is a month when it opens with a year and a
  // day otherwise; one is a year at four digits and a day at one or two.
  const [from, to] =
    parts.length === 3
      ? oneDay(`${parts[0]}-${pad(parts[1])}-${pad(parts[2])}`)
      : parts.length === 2
        ? parts[0].length === 4
          ? wholeMonth(`${parts[0]}-${pad(parts[1])}`)
          : oneDay(`${year}-${pad(parts[0])}-${pad(parts[1])}`)
        : parts[0].length === 4
          ? [`${parts[0]}-01-01`, `${parts[0]}-12-31`]
          : oneDay(`${year}-${month}-${pad(parts[0])}`)

  if (!isDay(from) || !isDay(to)) return null
  // A day that has not happened cannot be recounted, and a month or year still
  // running is trimmed to the part of it that has — asking for 2026 in August
  // means the eight months there are, not a refusal.
  if (from > today) return null
  return { from, to: to > today ? today : to }
}

const oneDay = (key) => [key, key]
// The last of a month is the day before the first of the next, which needs no
// table of month lengths and gets February right in every year.
const wholeMonth = (key) => {
  const [y, m] = key.split('-').map(Number)
  const nextFirst = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
  return [`${key}-01`, isDay(nextFirst) ? shift(nextFirst, -1) : null]
}

// The Sunday on or before the given day. Parsed as UTC deliberately: the key is
// already the developer's own calendar date, and re-reading it in local time
// would shift it a day for anyone west of Greenwich.
export function weekStart(key) {
  const day = new Date(`${key}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - day.getUTCDay())
  return day.toISOString().slice(0, 10)
}

const empty = () => ({
  currency: null, amount: 0, orders: 0, refunds: 0, refunded: 0, uncounted: 0, currencies: {},
})

// A buyer whose currency Play did not report. Filed under a key rather than
// dropped, so the split always accounts for every order in the day — and so a
// bucket written by this version always has at least one entry, which is what
// tells it apart from one written before the split existed.
export const UNKNOWN_CURRENCY = '?'

const perCurrency = () => ({ amount: 0, orders: 0, refunds: 0, refunded: 0, uncounted: 0 })

// A bucket predating the split has no entry at all; one written since always
// has at least the '?' key. The difference matters because a question about a
// single currency answered from days that were never split apart would come
// back short, and read as a quiet month rather than as a missing record.
export const hasBreakdown = (bucket) => Object.keys(bucket?.currencies ?? {}).length > 0

// The same payout-currency figure that went into the day's own amount, only
// filed under the currency the buyer paid in. Deliberately not a second
// conversion and not a fresh sign: the split adds back up to the day because it
// is the day's own numbers, dealt into piles.
function attribute(currencies, code, { amount, refund, counted }) {
  const next = { ...perCurrency(), ...currencies?.[code] }
  if (refund) next.refunds += 1
  else next.orders += 1
  if (counted) next.amount += amount
  else next.uncounted += 1
  if (refund && counted) next.refunded += amount
  return { ...currencies, [code]: next }
}

// Only money already in the developer's own currency is summed. An order whose
// currency pair has never been observed cannot be converted, and quietly adding
// NOK to a KRW total would produce a number that looks right and is not. Same for
// a refund with no charge to take back out. Either way the message above printed
// a figure the amount does not carry, so it is counted apart and the line says so.
export function record(buckets, key, { net, refund, currency, from }) {
  // Merged onto a fresh shape rather than used as-is: a bucket written by an
  // older version is missing fields added since, and += on undefined is NaN.
  const prev = { ...empty(), ...buckets[key] }
  const next = { ...prev, currency: prev.currency ?? currency ?? null }
  const counted = Boolean(net && currency && net.currency === currency)
  if (refund) next.refunds += 1
  else next.orders += 1
  if (counted) next.amount += net.amount
  else next.uncounted += 1
  // How much of the amount was money going back out. Carried apart so the line
  // can say what the refunds were worth, not just how many there were.
  if (refund && net && net.currency === currency) next.refunded += net.amount
  // Only the code is taken from the buyer's side, never the figure. Play's sign
  // convention on a reversal is not something this can rely on — the reason
  // fx.js refuses to learn a rate from one — so what gets filed under the code
  // is the payout figure above, which a reversal has already negated correctly.
  next.currencies = attribute(prev.currencies, from || UNKNOWN_CURRENCY, {
    amount: net?.amount ?? 0, refund, counted,
  })
  return { ...buckets, [key]: next }
}

// Every bucket whose key starts with the prefix: a full day key sums one day, a
// "YYYY-MM" prefix sums the month. Same function either way, so the two figures
// can never drift apart.
export const sum = (buckets, prefix) => fold(buckets, (key) => key.startsWith(prefix))

// A week straddles months, so it cannot be a prefix. It can be a range, because
// ISO dates compare lexicographically — which is the whole reason for the format.
export const sumRange = (buckets, from, to) => fold(buckets, (key) => key >= from && key <= to)

function fold(buckets, wanted) {
  const out = empty()
  for (const [key, b] of Object.entries(buckets)) {
    if (!wanted(key)) continue
    out.currency ??= b.currency
    out.amount += b.amount
    out.orders += b.orders
    out.refunds += b.refunds
    out.refunded += b.refunded ?? 0
    out.uncounted += b.uncounted
    for (const [code, c] of Object.entries(b.currencies ?? {})) {
      const at = out.currencies[code] ?? perCurrency()
      out.currencies[code] = {
        amount: at.amount + (c.amount ?? 0),
        orders: at.orders + (c.orders ?? 0),
        refunds: at.refunds + (c.refunds ?? 0),
        refunded: at.refunded + (c.refunded ?? 0),
        uncounted: at.uncounted + (c.uncounted ?? 0),
      }
    }
  }
  return out
}

// What each charge actually added, so a reversal takes out exactly that rather
// than a fresh estimate of it. The two are not the same number: a charge counted
// from Play's reported payout and a reversal Play has not settled yet would be
// estimated at the default fee rate, and the difference would sit in the total
// for good.
//
// Bounded by count rather than by age, unlike the buckets: an account busy enough
// to evict an entry still inside the bucket window falls back to counting that
// refund without subtracting it, which is the safe direction to be wrong in.
export const MAX_COUNTED = 5000

// A fourth field, present only while the figure is a guess. Play reports no net
// at all until it settles an order, so what the tally counts at announce time is
// an estimate off the price the buyer was charged — right for nearly every
// order, and wrong for one whose discount Google funds, where the buyer pays 400
// and the developer banks 2,500.
//
// Flagged rather than worked out again later, so a figure Play has already
// settled is not "corrected" every poll for the rest of its life by the couple
// of units a moving exchange rate shifts it.
export const ESTIMATED = 'e'

export function remember(ledger, id, { currency, amount, estimated }, max = MAX_COUNTED) {
  if (ledger.some(([known]) => known === id)) return ledger
  const next = [...ledger, estimated ? [id, amount, currency, ESTIMATED] : [id, amount, currency]]
  return next.length > max ? next.slice(next.length - max) : next
}

// Entries written before this field existed read as settled, so they are never
// touched. Their figures are put right with /recount, which is the tool for a
// tally that has drifted from Play for any reason.
export const isEstimate = (ledger, id) =>
  ledger.find(([known]) => known === id)?.[3] === ESTIMATED

// Play has settled it: the entry stops being a guess and carries what the tally
// actually counted, which is what a later reversal has to take back out.
export const confirm = (ledger, id, amount) =>
  ledger.map((entry) => (entry[0] === id ? [entry[0], amount, entry[2]] : entry))

// The currency has to match. A developer paid in a different currency than when
// the charge was counted would otherwise have an old figure taken straight out of
// a total kept in the new one.
export function amountFor(ledger, id, currency) {
  const found = ledger.find(([known]) => known === id)
  if (!found) return null
  // Zero is zero in every currency — which is what the entries banked for orders
  // adopted at first sync are worth. Any other figure has to have been counted in
  // the same currency the total is kept in.
  return found[1] === 0 || found[2] === currency ? found[1] : null
}

// Money already counted, found to be worth something else. The day keeps its
// order counts — nothing new happened, the same order simply turned out to be
// worth a different figure — and the currency split moves with the amount, or it
// would stop adding up to the day it was split from.
//
// A day the bucket window has already dropped is left alone rather than
// recreated: putting it back would resurrect a single order as if it were the
// whole day's takings.
export function resettle(buckets, key, code, amount) {
  const prev = buckets[key]
  if (!prev || !amount) return buckets
  // A bucket that has a split but no row under this code yet gets one: moving
  // the day's amount and leaving the split behind would have the two disagree,
  // which is the one thing the split is not allowed to do.
  //
  // A bucket from before the split existed gets nothing. Its orders were never
  // filed under any currency, so one row here could only ever hold this
  // correction and not the money it is correcting — and the day would stop
  // being reported as unsplit while still being short by everything else in it.
  // A gap that says it is a gap beats one that has been papered over.
  const at = prev.currencies?.[code]
  if (!at && !hasBreakdown(prev)) {
    return { ...buckets, [key]: { ...prev, amount: prev.amount + amount } }
  }
  const row = at ?? perCurrency()
  return {
    ...buckets,
    [key]: {
      ...prev,
      amount: prev.amount + amount,
      currencies: { ...prev.currencies, [code]: { ...row, amount: row.amount + amount } },
    },
  }
}

// A hand-entered correction, kept in buckets of the same shape so the same fold
// answers the day, the week and the month for it too. The counts are left at
// zero: what is being corrected is an amount the tally got wrong, not an order it
// failed to see, and inventing an order would make the count disagree with the
// messages the reader was actually sent.
export function adjust(buckets, key, { currency, amount }) {
  const prev = { ...empty(), ...buckets[key] }
  if (prev.currency && currency && prev.currency !== currency) return null
  return {
    ...buckets,
    [key]: { ...prev, currency: prev.currency ?? currency ?? null, amount: prev.amount + amount },
  }
}

// Announced orders and hand-entered corrections, added up as one figure. Kept
// apart in storage — a poll writing its buckets back must not be able to lose a
// correction entered while it was in flight — so they are only ever brought
// together here.
export function combine(a, b) {
  const crossed = a.currency && b.currency && a.currency !== b.currency
  return {
    ...a,
    currency: a.currency ?? b.currency,
    // A correction in another currency is not quietly added to this one, for the
    // same reason an order in one is not.
    amount: a.amount + (crossed ? 0 : b.amount),
    uncounted: a.uncounted + (crossed && b.amount ? 1 : 0),
  }
}

// One day's figure, announced orders and hand-entered corrections together.
// Exported rather than written out per caller: /today and the ledger the model
// reads answer from the same expression, and a second copy of it is how one of
// them starts reporting a correction the other does not.
export const dayOf = (totals, adjustments, day) => combine(sum(totals, day), sum(adjustments, day))

// The day counting started, as a timestamp. An install that was already counting
// before the ledger existed has no entry for those charges, and this is what
// tells a refund of one of them from a refund of history that was never counted.
export function startedAt(buckets) {
  const keys = Object.keys(buckets).sort()
  return keys.length ? Date.parse(`${keys[0]}T00:00:00Z`) : null
}

// Keys sort lexicographically because they are ISO dates, which is the whole
// reason for that format.
export function trim(buckets, max = MAX_DAYS) {
  const keys = Object.keys(buckets).sort()
  if (keys.length <= max) return buckets
  return Object.fromEntries(keys.slice(keys.length - max).map((k) => [k, buckets[k]]))
}
