// Test purchases, and how they are told apart from real ones.
//
// Play does not flag them. A license tester's order comes back with the same
// events in the same order, the same states, the same buyer country and the
// same money fields as a paying customer's — checked against a live account,
// every path in the response separates the two nowhere. The sole difference is
// that the product title arrives with a localized "Test: " glued to the front,
// which is exactly what the Console renders in the row.
//
// So the prefix is the only signal there is, and it is written in whatever
// language the Console account is set to — the request's Accept-Language does
// not move it. Rather than ship the word in fifty languages and be wrong in the
// fifty-first, it is read off the orders themselves: the same product bought for
// real and bought by a tester differ by that prefix and by nothing else, so the
// prefix is what one title carries and the other does not.

// A product is a package and a sku together — the same pairing subs.js infers
// billing periods over, and for the same reason: a title belongs to a product,
// not to a buyer.
const productOf = (o) => `${o.packageName ?? ''}|${o.sku ?? ''}`

// "테스트: " is five characters, "Test: " is six. A cap this loose still refuses
// the case that matters, which is one whole title happening to end with another.
const MAX_PREFIX = 16

// Titles are editable, and a product renamed from "Gold" to "Bonus: Gold" would
// otherwise brand its own history as tests. One product renamed is ordinary; the
// same words standing in front of two unrelated products is the Console putting
// them there, not the developer.
const MIN_PRODUCTS = 2

// It has to read as a label rather than as part of a name. Play writes a colon
// and a space, and requiring the colon is what keeps "Premium " out of
// "Premium Yearly" — a rename that merely adds a word is not a test marker.
const LABEL = /[:：]\s*$/

// Every prefix the orders themselves vouch for. Pure: the caller decides what to
// do with what was learned and where to keep it.
export function learnPrefixes(orders) {
  const titles = new Map()
  for (const o of orders) {
    const title = String(o?.product ?? '')
    if (!title) continue
    const key = productOf(o)
    if (!titles.has(key)) titles.set(key, new Set())
    titles.get(key).add(title)
  }

  const votes = new Map()
  for (const [product, seen] of titles) {
    for (const long of seen) {
      for (const short of seen) {
        if (short === long || !short || !long.endsWith(short)) continue
        const prefix = long.slice(0, long.length - short.length)
        if (prefix.length > MAX_PREFIX || !LABEL.test(prefix)) continue
        if (!votes.has(prefix)) votes.set(prefix, new Set())
        votes.get(prefix).add(product)
      }
    }
  }
  return [...votes]
    .filter(([, products]) => products.size >= MIN_PRODUCTS)
    .map(([prefix]) => prefix)
    .sort()
}

export const isTest = (order, prefixes) => {
  const title = String(order?.product ?? '')
  return prefixes.some((p) => title.startsWith(p))
}

// Left alone when nothing has been learned yet. Guessing at a marker would drop
// real money out of the tally, and a tally short a sale is worse than one
// carrying a test purchase the reader can see is a test purchase.
export const withoutTests = (orders, prefixes) =>
  prefixes.length ? orders.filter((o) => !isTest(o, prefixes)) : orders

export const PREFIX_KEY = 'testPrefixes'

// Kept, because learning needs both forms of a title in hand at once and a
// two-day poll rarely holds both. What a month of history gave up is what a
// single fetch is then read against. Only ever added to: a prefix that was true
// once does not stop being true because this batch had no real sale to contrast.
export async function learn(orders) {
  const { [PREFIX_KEY]: kept } = await chrome.storage.local.get({ [PREFIX_KEY]: [] })
  const found = learnPrefixes(orders).filter((p) => !kept.includes(p))
  if (!found.length) return kept
  const merged = [...kept, ...found].sort()
  await chrome.storage.local.set({ [PREFIX_KEY]: merged })
  return merged
}
