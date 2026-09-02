import { packageList } from './settings.js'
import { keyFor } from './playconsole.js'
import { convert } from './fx.js'

// Which orders reach Telegram. Note the deliberate split from what gets recorded
// as seen: filtered-out orders are still remembered, so widening a filter later
// announces future orders rather than dumping the backlog that was filtered out
// while the narrower setting was in force.
export function matches(order, settings, fx = {}) {
  if (order.state === 'charged' && !settings.notifyCharged) return false
  if (order.state === 'refunded' && !settings.notifyRefunded) return false

  const only = packageList(settings.packages)
  if (only.length && !only.includes(order.packageName)) return false

  const min = Number(settings.minPayout) || 0
  if (min > 0) {
    // The minimum is written in the currency the developer is paid in, so that is
    // what it has to be compared against. Payout is already that figure; the
    // buyer's total is not, and comparing 4.99 to 1000 mutes real orders.
    const own = order.payout ?? convert(order.total, fx.currency, fx.rates)
    // Magnitude, not the signed figure: a reversal Play signs negative is below
    // every positive minimum, and muting it would leave the charge it undoes
    // sitting in the running total for good. An amount that cannot be brought into
    // the right currency is not muted at all — failing to hush an order is a far
    // cheaper mistake than dropping one out of the running total — except a zero,
    // which is under every positive minimum in any currency. Test purchases no
    // longer reach here at all; see testorders.js. A free trial still does, and a
    // zero is what it is worth.
    if (own ? Math.abs(own.amount) < min : order.total?.amount === 0) return false
  }

  return true
}

// Splits a fetched page into what to send and what to bank silently. Kept pure
// and separate from delivery so the ordering rules — which are easy to get
// subtly wrong — can be tested directly.
//
// There is no cap. A batch used to stop at ten and stand the rest down with a
// count — "…and 5 more" — which is the one thing a sales notifier must not do:
// the orders it hid were real money, and a line saying so is not the message
// anybody installed this for. A big batch is now simply a big batch, paced out
// at the rate Telegram accepts.
export function plan(terminal, seenKeys, settings, fx = {}) {
  const seen = new Set(seenKeys)
  const unseen = terminal.filter((o) => !seen.has(keyFor(o)))
  const fresh = unseen.filter((o) => matches(o, settings, fx))
  return {
    // Oldest first, so a burst reads in the order it happened.
    batch: [...fresh].reverse(),
    muted: unseen.filter((o) => !matches(o, settings, fx)),
    freshCount: fresh.length,
    unseenCount: unseen.length,
  }
}
