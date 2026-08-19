import { packageList } from './settings.js'
import { keyFor } from './playconsole.js'

// Which orders reach Telegram. Note the deliberate split from what gets recorded
// as seen: filtered-out orders are still remembered, so widening a filter later
// announces future orders rather than dumping the backlog that was filtered out
// while the narrower setting was in force.
export function matches(order, settings) {
  if (order.state === 'charged' && !settings.notifyCharged) return false
  if (order.state === 'refunded' && !settings.notifyRefunded) return false

  const only = packageList(settings.packages)
  if (only.length && !only.includes(order.packageName)) return false

  const min = Number(settings.minPayout) || 0
  if (min > 0) {
    // Payout is the developer-currency figure; total is the buyer's. Falling back
    // keeps the filter meaningful for orders Play has not settled a payout for.
    const amount = order.payout?.amount ?? order.total?.amount ?? 0
    if (amount < min) return false
  }

  return true
}

// Splits a fetched page into what to send, what to mention only as a count, and
// what to bank silently. Kept pure and separate from delivery so the ordering
// rules — which are easy to get subtly wrong — can be tested directly.
export function plan(terminal, seenKeys, settings, limit) {
  const seen = new Set(seenKeys)
  const unseen = terminal.filter((o) => !seen.has(keyFor(o)))
  const fresh = unseen.filter((o) => matches(o, settings))
  return {
    // Oldest first, so a burst reads in the order it happened.
    batch: fresh.slice(0, limit).reverse(),
    overflow: fresh.slice(limit),
    muted: unseen.filter((o) => !matches(o, settings)),
    freshCount: fresh.length,
    unseenCount: unseen.length,
  }
}
