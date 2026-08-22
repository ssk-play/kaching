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

const empty = () => ({ currency: null, amount: 0, orders: 0, refunds: 0, uncounted: 0 })

// Only money already in the developer's own currency is summed. An order whose
// currency pair has never been observed cannot be converted, and quietly adding
// NOK to a KRW total would produce a number that looks right and is not — so it
// is counted as uncounted instead, and the total says so.
export function record(buckets, key, { net, refund, currency }) {
  const prev = buckets[key] ?? empty()
  const next = { ...prev, currency: prev.currency ?? currency ?? null }
  if (refund) next.refunds += 1
  else next.orders += 1
  if (net && currency && net.currency === currency) next.amount += net.amount
  else if (net) next.uncounted += 1
  else if (!refund) next.uncounted += 1
  return { ...buckets, [key]: next }
}

// Every bucket whose key starts with the prefix: a full day key sums one day, a
// "YYYY-MM" prefix sums the month. Same function either way, so the two figures
// can never drift apart.
export function sum(buckets, prefix) {
  const out = empty()
  for (const [key, b] of Object.entries(buckets)) {
    if (!key.startsWith(prefix)) continue
    out.currency ??= b.currency
    out.amount += b.amount
    out.orders += b.orders
    out.refunds += b.refunds
    out.uncounted += b.uncounted
  }
  return out
}

// Keys sort lexicographically because they are ISO dates, which is the whole
// reason for that format.
export function trim(buckets, max = MAX_DAYS) {
  const keys = Object.keys(buckets).sort()
  if (keys.length <= max) return buckets
  return Object.fromEntries(keys.slice(keys.length - max).map((k) => [k, buckets[k]]))
}
