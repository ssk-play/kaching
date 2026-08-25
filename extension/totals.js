// Running totals, kept as one bucket per day.
//
// Days rather than a single counter: a daily figure has to reset itself, and a
// monthly one has to be answerable months later without having been asked for
// in advance. Buckets give both from the same store.

// A year of history answers any /month query worth asking and still bounds the
// object to something that fits comfortably in chrome.storage.local.
export const MAX_DAYS = 400

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

// The Sunday on or before the given day. Parsed as UTC deliberately: the key is
// already the developer's own calendar date, and re-reading it in local time
// would shift it a day for anyone west of Greenwich.
export function weekStart(key) {
  const day = new Date(`${key}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - day.getUTCDay())
  return day.toISOString().slice(0, 10)
}

const empty = () => ({
  currency: null, amount: 0, orders: 0, refunds: 0, refunded: 0, uncounted: 0,
})

// Only money already in the developer's own currency is summed. An order whose
// currency pair has never been observed cannot be converted, and quietly adding
// NOK to a KRW total would produce a number that looks right and is not. Same for
// a refund with no charge to take back out. Either way the message above printed
// a figure the amount does not carry, so it is counted apart and the line says so.
export function record(buckets, key, { net, refund, currency }) {
  // Merged onto a fresh shape rather than used as-is: a bucket written by an
  // older version is missing fields added since, and += on undefined is NaN.
  const prev = { ...empty(), ...buckets[key] }
  const next = { ...prev, currency: prev.currency ?? currency ?? null }
  if (refund) next.refunds += 1
  else next.orders += 1
  if (net && currency && net.currency === currency) next.amount += net.amount
  else next.uncounted += 1
  // How much of the amount was money going back out. Carried apart so the line
  // can say what the refunds were worth, not just how many there were.
  if (refund && net && net.currency === currency) next.refunded += net.amount
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

export function remember(ledger, id, { currency, amount }, max = MAX_COUNTED) {
  if (ledger.some(([known]) => known === id)) return ledger
  const next = [...ledger, [id, amount, currency]]
  return next.length > max ? next.slice(next.length - max) : next
}

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
// Exported rather than written out per caller: /today and /ai answer from the
// same expression, and a second copy of it is how one of them starts reporting a
// correction the other does not.
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
