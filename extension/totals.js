// Running totals, kept as one bucket per day.
//
// Days rather than a single counter: a daily figure has to reset itself, and a
// monthly one has to be answerable months later without having been asked for
// in advance. Buckets give both from the same store.

// How far back the buckets keep anything, and so — since /recount cannot restate
// a day that will be trimmed off on the next write — how far back the books can
// reach at all.
//
// Three years. A day costs about 400 bytes once it carries both splits,
// so the whole store is well under a megabyte against the ten chrome.storage
// .local gives, and the folds that answer /month walk it in no time. The old
// four hundred was set when a recount could only restate days the tally already
// had; once it could go and fetch history instead, that number stopped being a
// storage bound and started being the answer to "how much of my past can I
// have".
export const MAX_DAYS = 1100

// The day an instant falls on, in the zone the reader configured. One zone
// decides this, the fetch window below, and the clock in an order line — see
// zoneOf in settings.js for why that is one lookup rather than a default
// repeated per call site.
//
// The zone is required, not defaulted. A call site that forgets it should fail
// where it stands: a default here would be a second calendar, and a second
// calendar is what filed orders into days that /recount then rebuilt from part
// of themselves.
export function dayKey(ms, timeZone) {
  // Intl reads an undefined zone as the host's, so a call site that forgot the
  // argument would not fail — it would quietly file into the machine's own
  // calendar, which is the exact second calendar this argument exists to
  // prevent. Refused here instead, where it is a coding error and not a tally.
  if (!timeZone) throw new Error('dayKey needs a time zone')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms))
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}

// How far the zone is from UTC at a given instant, in ms. Read by formatting the
// instant in that zone and reading the result back as though it were UTC: the
// difference between the two is the offset that was in force. h23 because an
// hour that formats as "24" would parse as the next day.
function offsetAt(ms, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  )
  return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) - ms
}

// The instant a day begins, as epoch ms. This is what makes a bucket and a fetch
// window the same thing: Play is asked for absolute time, and a day is a range
// of absolute time only once somebody works out where its edges are.
//
// Twice, because the offset has to be read at the instant it applies and the
// first read is at the wrong one. On a spring-forward day in a zone with DST the
// first guess lands in the hour that does not exist, and the second pass moves
// it to the instant the clock actually starts the day at.
export function startOf(key, timeZone) {
  if (!timeZone) throw new Error('startOf needs a time zone')
  const wall = Date.parse(`${key}T00:00:00Z`)
  const guess = wall - offsetAt(wall, timeZone)
  return wall - offsetAt(guess, timeZone)
}

// The instant after a day's last, so a range is half-open and the two ends of
// consecutive days meet exactly rather than overlapping by a millisecond.
export const endOf = (key, timeZone) => startOf(shift(key, 1), timeZone)

export const monthKey = (key) => key.slice(0, 7)

// The shape of a bucket key. Exported because the command parser and the ledger
// read both have to turn away a day they cannot look up, and two copies of this
// is how the two start disagreeing about what a day is.
export const DAY = /^\d{4}-\d{2}-\d{2}$/

// A key moved by whole days. Parsed as UTC for the same reason weekStart is.
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
//   6             June of this year
//   6월           the same, for anyone typing Korean
//   08-20         the 20th of August this year
//   2026-08-20    that day
//   2026-08       that whole month
//   2026          that whole year
//   all           the same as nothing
//
// Bare is the whole lot because that is what someone typing a command called
// "fetch it again" is asking for. Today is by name, since it is the one span
// short enough that nobody wants to work out its date first.
//
// What is missing is filled in from the left — year, then month, then day — and
// read off today. That is what makes the short forms worth having: the month
// someone wants to recount is nearly always in the year they are standing in.
// So a lone number is whatever comes first after the parts it left off: four
// digits is a year, and one or two is a month.
//
// A lone number used to be a day of this month. It changed because of what this
// command is for — a recount reads a span back out of Play, and the span people
// ask for is a month or a year far more often than a single day. A day is still
// one keystroke longer as "08-20", which the refusal below names when a number
// arrives that is no month.
//
// Deliberately not shared with /adjust. There a lone "20" is an amount, and a
// parser that read it as the twentieth would move a day nobody named.
const ALL = new Set(['all', '전체', '*'])
const TODAY = new Set(['today', '오늘'])

export function periodOf(text, today) {
  // "6월" says month in the plainest way there is, and the chat this is typed
  // into is as often Korean as English. Stripped rather than parsed separately,
  // so it lands on exactly the same rule a bare number does.
  // Only when digits are left behind. A bare "월" — half of "8월", typed and
  // sent — would otherwise strip to nothing and read as "recount everything",
  // which is the two-minute refetch of the whole history.
  const raw = String(text ?? '').trim().toLowerCase().replace(/^(\d{1,2})월$/, '$1')
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
          // A month of this year. Not a day: see the note above about what a
          // recount is usually asked for. Thirteen and up is no month, and
          // wholeMonth would build "2026-20-01", which isDay rejects below — so
          // it comes back as a refusal rather than as some other month.
          : wholeMonth(`${year}-${pad(parts[0])}`)

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

// The Sunday on or before the given day. Parsed as UTC, like the key itself and
// like every other date in this file — read in local time it would shift a day
// for anyone west of Greenwich.
export function weekStart(key) {
  const day = new Date(`${key}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - day.getUTCDay())
  return day.toISOString().slice(0, 10)
}

const empty = () => ({
  currency: null, amount: 0, orders: 0, refunds: 0, refunded: 0, uncounted: 0,
  currencies: {}, kinds: {}, periods: {},
})

// The splits a day is dealt into besides its own total. Named in one place
// because every fold, every merge and every read has to walk the same list —
// a third one added to some of them and not the others is a figure that stops
// adding up to the day it came from.
const SPLITS = ['currencies', 'kinds', 'periods']

// A buyer whose currency Play did not report. Filed under a key rather than
// dropped, so the split always accounts for every order in the day — and so a
// bucket written by this version always has at least one entry, which is what
// tells it apart from one written before the split existed.
export const UNKNOWN_CURRENCY = '?'

// One row of a split. The same five fields whichever split it belongs to, so a
// question about a currency and a question about renewals are answered from the
// same shape and read the same way.
const perSplit = () => ({ amount: 0, orders: 0, refunds: 0, refunded: 0, uncounted: 0 })

// What kind of sale an order was. A renewal is a subscription charge after the
// first, which is the distinction the count exists for: five renewals and five
// new subscriptions are the same revenue and very different news.
export const KIND_BUY = 'buy'
export const KIND_SUB = 'sub'
export const KIND_RENEWAL = 'renewal'
// An order this could not place — filed rather than dropped, for the same reason
// the currency split files '?'.
const UNKNOWN_KIND = '?'

// How often the subscription behind a charge bills. Worked out in subs.js from
// the run of charges sharing an order id, because a single order does not carry
// it — see the note there.
//
// A one-off purchase is filed under its own key rather than left out. Every
// split here adds back up to the day it came from, and that is worth more than
// a tidier list: a "periods" split that quietly omitted every purchase would
// look like a total and be one only for subscriptions.
export const PERIOD_NONE = 'none'
// The plans Play sells. Worked out in subs.js and named here, beside the other
// two splits' keys — a bucket key defined in the module that writes it and again
// in the module that reads it is two definitions of one string, and the day the
// two disagree the split grows a second row meaning the same thing.
export const PERIOD_WEEKLY = 'weekly'
export const PERIOD_MONTHLY = 'monthly'
export const PERIOD_QUARTERLY = 'quarterly'
export const PERIOD_YEARLY = 'yearly'
// A subscription whose period could not be worked out, for the same reason the
// other two splits file '?': a total that omits what it could not classify reads
// as a total.
export const UNKNOWN_PERIOD = '?'

// The same payout-currency figure that went into the day's own amount, only
// filed under the currency the buyer paid in. Deliberately not a second
// conversion and not a fresh sign: the split adds back up to the day because it
// is the day's own numbers, dealt into piles.
function attribute(split, key, { amount, refund, counted }) {
  const next = { ...perSplit(), ...split?.[key] }
  if (refund) next.refunds += 1
  else next.orders += 1
  if (counted) next.amount += amount
  else next.uncounted += 1
  if (refund && counted) next.refunded += amount
  return { ...split, [key]: next }
}

// Only money already in the developer's own currency is summed. An order whose
// currency pair has never been observed cannot be converted, and quietly adding
// NOK to a KRW total would produce a number that looks right and is not. Same for
// a refund with no charge to take back out. Either way the message above printed
// a figure the amount does not carry, so it is counted apart and the line says so.
// The same work, done into a map the caller owns. A fold over three years of
// orders calls this once per order, and `record` below copies the whole map of
// days on every call — which at eleven thousand orders against three and a half
// thousand days is forty million entry copies, and turned a read that should be
// instant into four seconds.
//
// The day itself is still rebuilt rather than mutated: it is a handful of fields
// and two small maps, and the copy is what keeps a bucket already handed out
// from changing under whoever is holding it.
export function recordInto(buckets, key, { net, refund, currency, from, kind, period }) {
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
  const share = { amount: net?.amount ?? 0, refund, counted }
  next.currencies = attribute(prev.currencies, from || UNKNOWN_CURRENCY, share)
  // The same figure again, dealt a second way. Both splits are the day's own
  // numbers rather than a re-reading of the order, so each of them adds back up
  // to the day and to the other.
  next.kinds = attribute(prev.kinds, kind || UNKNOWN_KIND, share)
  // And a third way: how often this money comes back. A renewal row answers
  // "how many renewals", this one answers "how many of them are monthly", which
  // is the question the month-ahead figure is built on.
  next.periods = attribute(prev.periods, period ?? UNKNOWN_PERIOD, share)
  buckets[key] = next
  return buckets
}

// The pure form, for callers holding a map they did not build.
export const record = (buckets, key, share) => recordInto({ ...buckets }, key, share)

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
    for (const split of SPLITS) {
      for (const [name, c] of Object.entries(b[split] ?? {})) {
        const at = out[split][name] ?? perSplit()
        out[split][name] = {
          amount: at.amount + (c.amount ?? 0),
          orders: at.orders + (c.orders ?? 0),
          refunds: at.refunds + (c.refunds ?? 0),
          refunded: at.refunded + (c.refunded ?? 0),
          uncounted: at.uncounted + (c.uncounted ?? 0),
        }
      }
    }
  }
  return out
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
