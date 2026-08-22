// Turning a buyer-currency figure into the developer's own.
//
// Play settles an order with both figures — net in what the buyer paid, payout
// in what the developer banks — so the rate between them is sitting in the
// orders already fetched. Nothing is looked up anywhere: an extension whose
// pitch is that nothing leaves the browser does not get to call an FX API.

const pair = (from, to) => `${from}>${to}`

// One rate per currency pair, the newest order winning — chosen by timestamp
// rather than by position, because the API returns newest first and taking the
// last match would have kept the oldest rate in the window.
//
// Refunds are skipped outright: Play's sign convention on a reversal is not
// something this can rely on, and one mismatched pair would store a negative
// rate that turns every later sale in that currency into money leaving. Same
// reason a non-positive rate is rejected even from a charge.
export function ratesFrom(orders) {
  const best = {}
  for (const o of orders) {
    if (o.state !== 'charged') continue
    const from = o.net
    const to = o.payout
    if (!from?.amount || !to?.amount || from.currency === to.currency) continue
    const rate = to.amount / from.amount
    if (!(rate > 0)) continue
    const key = pair(from.currency, to.currency)
    const at = Number(o.at ?? 0)
    if (best[key] && best[key].at > at) continue
    best[key] = { rate, at }
  }
  return Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.rate]))
}

// A quiet week in one currency should not cost the rate learned last week, so
// what was observed before is kept until something newer replaces it.
export const merge = (stored, fresh) => ({ ...stored, ...fresh })

// Which currency the developer is actually paid in — read off the orders rather
// than configured, because a wrong setting here would silently mislabel money.
export function payoutCurrency(orders) {
  const tally = {}
  for (const o of orders) {
    if (o.payout?.currency) tally[o.payout.currency] = (tally[o.payout.currency] ?? 0) + 1
  }
  return Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

// null when the pair has never been seen, so the caller can say so rather than
// convert at a rate nobody observed.
export function rateFor(from, to, rates) {
  if (!from || !to || from === to) return null
  const rate = rates?.[pair(from, to)]
  return rate > 0 ? rate : null
}

// The caller keeps the buyer-currency figure when this returns null — a number
// in the wrong currency still beats no number, but a converted one at a guessed
// rate does not.
export function convert(money, to, rates) {
  if (!money || !to) return null
  if (money.currency === to) return money
  const rate = rateFor(money.currency, to, rates)
  return rate ? { currency: to, amount: money.amount * rate } : null
}
