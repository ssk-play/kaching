// The orders themselves, kept. Everything else about the money is worked out
// from these rather than remembered alongside them.
//
// It used to be the other way round: a running total per day, plus a ledger of
// what each charge had added to it, plus a flag marking which of those figures
// were still guesses, plus a pass that moved a day when Play settled one. All of
// that machinery existed for one reason — the total could not be recomputed, so
// every later correction had to be applied to it by hand, and every new question
// ("split by currency", "how many renewals") could only be answered for days
// recorded after the question was thought of.
//
// Keeping the orders costs the same. A normalized order is about 435 bytes of
// JSON and a day's bucket with both its splits was about 432, and this account
// takes roughly one order a day. What it buys is that a new question is a new
// fold over what is already here, answerable across the whole history the
// moment it is written, and that a settled figure or a refund is simply the
// order being stored again.
//
// Chunked by month so a poll rewrites the current month rather than three years.
import { dayKey, recordInto as tally, MAX_DAYS, PERIOD_NONE } from './totals.js'
import { estimatedNet, kindOf } from './format.js'
import { periodLookup } from './subs.js'
import { learn, withoutTests } from './testorders.js'

// pending is not an event; see background.js. It is not stored either, or a
// pending order would sit in the tally as a sale that has not happened.
const TERMINAL = new Set(['charged', 'refunded'])

export const chunkFor = (day) => `orders:${day.slice(0, 7)}`

// Every month key between two days, oldest first. Built by walking the calendar
// rather than by reading what is in storage: a month with no orders has no chunk,
// and asking for a key that is not there costs nothing and keeps this a pure
// function of the range.
export function chunksBetween(from, to) {
  const out = []
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); ) {
    out.push(`orders:${m}`)
    const [y, mo] = m.split('-').map(Number)
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
  }
  return out
}

// One record per order id, whichever arrived last. Play returns an order under
// the state it is in now and fills its payout in days later, so the same id
// comes back changed — and the newest version is the true one. Merging on id
// rather than appending is what makes storing an order idempotent, which is what
// lets a poll and a /recount overlap without counting anything twice.
export function merge(kept, incoming) {
  const by = new Map(kept.map((o) => [o.id, o]))
  for (const o of incoming) {
    if (!TERMINAL.has(o.state)) continue
    by.set(o.id, o)
  }
  return [...by.values()].sort((a, b) => a.at - b.at)
}

// The tally, folded out of the orders. This is the only place a day's figure is
// worked out, so /today, the model's read and a /recount cannot disagree about
// one: there is nothing to disagree with.
//
// `fx` carries the developer's currency and the rates read off settled orders.
// An order that cannot be converted into that currency is counted as uncounted
// rather than added across currencies, exactly as before.
// Writes into the map it is given and returns it. See foldDays below.
//
// `periodOf` answers how often the subscription behind an order bills. It is
// passed in rather than worked out here because it cannot be: the period is a
// property of the whole run of charges sharing an order id, and this sees one
// order. A caller with only the one order — the running footer under a batch of
// announcements — passes nothing and the order lands under the unknown key,
// which is honest: from one order the period is unknown.
export function countInto(buckets, o, zone, fx, periodOf) {
  if (!TERMINAL.has(o.state)) return buckets
  const day = dayKey(o.at, zone)
  const paid = estimatedNet(o, fx)
  const kind = kindOf(o)
  const period = periodOf ? periodOf(o) ?? PERIOD_NONE : undefined
  const share = {
    net: paid, currency: fx.currency, from: o.net?.currency, kind, period,
    pkg: o.packageName,
  }
  if (o.state !== 'refunded') return tally(buckets, day, { ...share, refund: false })
  // Play returns a refunded order once, as the reversal alone. The charge it
  // reverses happened too, and on this same day — a reversal is filed under the
  // day of the order, not the day of the refund. Counting only the minus would
  // leave the day short by a charge it did receive, and a day that netted to
  // zero would read as one that never sold anything.
  const gross = paid && { currency: paid.currency, amount: -paid.amount }
  return tally(
    tally(buckets, day, { ...share, net: gross, refund: false }),
    day,
    { ...share, refund: true },
  )
}

// One accumulator for the whole fold, which is why countInto takes a map it may
// write to rather than returning a copy: this is called once per order over the
// entire history, and copying the map of days each time is quadratic.
export const foldDays = (orders, zone, fx) => {
  // Built once for the whole fold. periodLookup walks every order to group the
  // subscription runs, so calling it per order would be quadratic — the same
  // trap the day map fell into before recordInto took an accumulator.
  const periodOf = periodLookup(orders)
  return orders.reduce((buckets, o) => countInto(buckets, o, zone, fx, periodOf), {})
}

// A month key moved by whole months, so a range can be widened past the chunk
// it starts in.
function shiftMonth(month, by) {
  const [y, m] = month.split('-').map(Number)
  const n = (y * 12 + (m - 1)) + by
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`
}

// Reads only the months the range touches. A question about last week opens one
// chunk; a question about all of it opens one per month, which for three years
// is under half a megabyte and folds in single-digit milliseconds.
//
// One month either side of the range, because a chunk is keyed by the day the
// order fell on in whatever zone was configured when it was written. Change the
// zone and an order near a month boundary is filed one chunk away from where
// this would now look for it — so this looks in both, and filters on the
// timestamp, which no setting can move.
export async function read(from, to, zone) {
  const keys = chunksBetween(
    `${shiftMonth(from.slice(0, 7), -1)}-01`,
    `${shiftMonth(to.slice(0, 7), 1)}-01`,
  )
  const held = await chrome.storage.local.get(Object.fromEntries(keys.map((k) => [k, []])))
  const found = []
  for (const key of keys) {
    for (const o of held[key] ?? []) {
      const day = dayKey(o.at, zone)
      if (day >= from && day <= to) found.push([key, o])
    }
  }
  return clean(pick(found, zone))
}

// What the store holds, minus the test purchases in it — and richer for the
// prefixes it just picked up on the way past. Reads are what make this
// retroactive: a store written by an earlier version keeps its test orders on
// disk and stops counting them, with no /recount asked of anyone.
const clean = async (kept) => withoutTests(kept, await learn(kept))

// One record per id, across chunks as well as within one. merge() dedupes inside
// a chunk, which is enough while an order only ever has one home — but the home
// is the chunk for the day it fell on in whatever zone was configured when it
// was written. Change the zone and a month-boundary order is written to the
// neighbouring chunk while the old copy stays put, and a read that unions both
// would count it twice for good.
//
// The copy in the chunk the order belongs in *now* wins, because that is where
// the newest write went; the other is a leftover of the old setting.
function pick(found, zone) {
  const by = new Map()
  for (const [key, o] of found) {
    const home = chunkFor(dayKey(o.at, zone))
    if (!by.has(o.id) || key === home) by.set(o.id, o)
  }
  return [...by.values()].sort((a, b) => a.at - b.at)
}

// Everything held, oldest first. The all-time reads and /recount's rebuild both
// want this, and neither of them knows a start date to ask for.
export async function readAll(zone) {
  const all = await chrome.storage.local.get(null)
  const found = []
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith('orders:') && Array.isArray(value)) {
      for (const o of value) found.push([key, o])
    }
  }
  return clean(pick(found, zone))
}

// Merged into the months they belong to, and only those months are written back.
export async function write(incoming, zone) {
  // Learned from the batch as fetched, then applied to it: a recount hands over
  // months at a time, which is where both forms of a title turn up together.
  incoming = withoutTests(incoming, await learn(incoming))
  if (!incoming.length) return []
  const wanted = new Map()
  for (const o of incoming) {
    if (!TERMINAL.has(o.state)) continue
    const key = chunkFor(dayKey(o.at, zone))
    if (!wanted.has(key)) wanted.set(key, [])
    wanted.get(key).push(o)
  }
  if (!wanted.size) return []

  // The months either side as well, so an order that used to live in one of them
  // under a different zone setting is taken out as this one is written. Leaving
  // it would put the same id in two chunks, and a read spanning both would count
  // it twice — pick() above repairs that on the way out, but a store that only
  // ever holds one copy is the thing worth having.
  const keys = [...wanted.keys()]
  const neighbours = keys.flatMap((k) => [
    `orders:${shiftMonth(k.slice('orders:'.length), -1)}`,
    `orders:${shiftMonth(k.slice('orders:'.length), 1)}`,
  ])
  const touched = [...new Set([...keys, ...neighbours])]
  const held = await chrome.storage.local.get(Object.fromEntries(touched.map((k) => [k, []])))

  const moved = new Set(incoming.map((o) => o.id))
  const patch = {}
  for (const key of touched) {
    const fresh = wanted.get(key)
    const kept = (held[key] ?? []).filter((o) => fresh || !moved.has(o.id))
    const next = fresh ? merge(kept, fresh) : kept
    // Untouched chunks are left alone rather than rewritten as they were.
    if (fresh || next.length !== (held[key] ?? []).length) patch[key] = next
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch)
  return keys
}

// The months past the window the tally reaches at all. Whole months rather than
// exact days: a chunk is the unit of storage, and half a month deleted out of
// one leaves a fold reporting a partial day as a quiet one.
export function expired(keys, today) {
  const floor = new Date(Date.parse(`${today}T00:00:00Z`) - MAX_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 7)
  return keys.filter((k) => k.startsWith('orders:') && k.slice('orders:'.length) < floor)
}

// Once a day at most. Finding what to drop means listing every key in storage,
// which reads the whole store back — several megabytes on a busy account, on a
// poll that runs every ten minutes, to delete something that can only become
// stale at midnight. The marker is the day it last looked.
export async function forget(today) {
  const { sweptOn } = await chrome.storage.local.get({ sweptOn: null })
  if (sweptOn === today) return []
  await chrome.storage.local.set({ sweptOn: today })
  const gone = expired(Object.keys(await chrome.storage.local.get(null)), today)
  if (gone.length) await chrome.storage.local.remove(gone)
  return gone
}
