// Turns a normalized order into the text that lands in Telegram.

import { t } from './i18n.js'

// Assembled from parts rather than a locale string: every locale punctuates
// dates differently, and two zones have to line up under each other.
function clock(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

function zoneLabel(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'short' }).formatToParts(
    new Date(ms),
  )
  return parts.find((x) => x.type === 'timeZoneName')?.value ?? ''
}

export function times(ms, { showLocalTime, showUtcTime }) {
  const out = []
  if (showLocalTime) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    out.push(`${clock(ms, zone)} ${zoneLabel(ms, zone)}`.trim())
  }
  if (showUtcTime) out.push(`${clock(ms, 'UTC')} UTC`)
  // Both off is a deliberate choice, so the line is dropped rather than
  // second-guessed — the caller filters empty lines out.
  return out.join(' / ')
}

const money = (m) =>
  m ? `${m.currency} ${m.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ''

// Play appends "..N" to the base order id once a subscription starts renewing:
// the first automatic renewal is "..0". So a suffix of N is the (N+2)th charge,
// and no suffix at all is the initial purchase.
const RENEWAL = /\.\.(\d+)$/

// 1 for a first purchase, 2+ for a renewal, null for anything not a
// subscription. A renewal announced as a new subscription is a lie the reader
// acts on — it reads as growth when it is retention.
export function cycleOf(order) {
  if (!order.subscription) return null
  const found = RENEWAL.exec(order.id ?? '')
  return found ? Number(found[1]) + 2 : 1
}

// Play's service fee is 15% on subscription revenue and on the first $1M of
// annual revenue — what nearly every order here is actually charged.
const DEFAULT_FEE = 0.15

// Play reports no net figure at all until it has settled an order, which is why
// one-time purchases arrived with the line missing entirely. The fee applies to
// the price with tax taken out, so that is what it has to be applied to.
function taxable(order) {
  if (order.beforeFee) return order.beforeFee
  if (!order.total) return null
  if (!order.tax) return order.total
  // Tax that cannot be subtracted would leave the fee applied to a base that
  // still contains it, printed next to the very tax line the breakdown exists
  // to let the reader check against. No figure beats one that does not add up.
  return order.total.currency === order.tax.currency
    ? { currency: order.total.currency, amount: order.total.amount - order.tax.amount }
    : null
}

const reportedNet = (order) => order.payout ?? order.net

// KRW and JPY have no minor unit, so an estimate carried at full precision
// prints an amount that cannot exist. Reported figures never needed this — Play
// settles them in whole units already.
function round(amount, currency) {
  let digits = 2
  try {
    digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits
  } catch {
    // An unrecognised currency code is not worth losing the figure over.
  }
  const scale = 10 ** digits
  return Math.round(amount * scale) / scale
}

// Reported figures first; the estimate only fills the gap. Both are labelled as
// estimates either way — even a settled figure moves with FX and adjustments.
export function estimatedNet(order) {
  const reported = reportedNet(order)
  // A refund is money leaving. A positive figure under a "Refund" heading reads
  // as income whether it was estimated or reported, and Play's own sign is the
  // only thing that can say otherwise — so a positive one is dropped rather
  // than negated into a number nothing in the response supports.
  if (order.state === 'refunded') return reported?.amount < 0 ? reported : null
  if (reported) return reported
  const base = taxable(order)
  if (!base) return null
  return { currency: base.currency, amount: round(base.amount * (1 - DEFAULT_FEE), base.currency) }
}

// Google's cut is not a fixed number — 15% or 30% depending on the programme —
// so it is derived from the order rather than assumed. `derived` is false when
// it could only be assumed, so the line can say so rather than pass the
// assumption off as a figure read out of the order.
export function feeRate(order) {
  const before = order.beforeFee?.amount
  const after = order.net?.amount
  if (before && after != null) {
    return { percent: Math.round((1 - after / before) * 100), derived: true }
  }
  // A reported figure with nothing to derive the rate from stays unexplained
  // rather than being attributed to a rate it may not have been charged.
  if (reportedNet(order)) return null
  return estimatedNet(order) ? { percent: DEFAULT_FEE * 100, derived: false } : null
}

function heading(order) {
  if (order.state === 'refunded') return `↩️ ${t('notifRefund')}`
  const cycle = cycleOf(order)
  if (cycle == null) return `🔔 ${t('notifNewOrder')}`
  return cycle > 1 ? `🔁 ${t('notifSubRenewal', cycle)}` : `🔔 ${t('notifNewSub')}`
}

export function describe(order, settings) {
  const head = heading(order)

  // The arrow used to run charged -> payout with nothing saying what the second
  // number was; naming it is the difference between a figure and a fact.
  const net = estimatedNet(order)
  const fee = feeRate(order)
  // A guessed figure has to say so on the line it appears on. The breakdown is
  // off by default, so leaving the disclaimer there would hide it from almost
  // everyone — and a guess that looks like a settled payout is the one failure
  // this line cannot afford.
  const netLabel = fee && !fee.derived ? t('labelNetAssumed', fee.percent) : t('labelNet')
  const price = [money(order.total), net ? `→ ${money(net)} ${netLabel}` : '']
    .filter(Boolean)
    .join(' ')

  // Tax withheld and the rate actually charged: between them the price line
  // above can be recomputed, which is the whole point of the setting. The net
  // itself is not repeated here — it would be the same label twice, once per
  // currency, with nothing saying which was which.
  const breakdown =
    settings.showBreakdown && (order.tax || fee?.derived)
      ? [
          order.tax ? `${t('labelTax')} ${money(order.tax)}` : '',
          fee?.derived ? t('labelFee', fee.percent) : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : ''

  // The product ID is what the Console, the Play API and your own code all key
  // on; the display name is the only part of it that can be edited later. A
  // name on its own leaves the reader guessing which SKU actually sold.
  const product = [order.product, order.sku === order.product ? '' : order.sku]
    .filter(Boolean)
    .join(' · ')

  return [
    settings.senderName ? `[${settings.senderName}] ${head}` : head,
    product,
    [order.packageName, order.country].filter(Boolean).join(' · '),
    price,
    breakdown,
    times(order.at, settings),
    order.id,
  ]
    .filter(Boolean)
    .join('\n')
}

// Status and failure notices carry the same label so a shared chat stays legible.
export const label = (settings, text) =>
  settings.senderName ? `[${settings.senderName}] ${text}` : text
