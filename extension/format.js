// Turns a normalized order into the text that lands in Telegram.

import { t } from './i18n.js'
import { convert, rateFor } from './fx.js'
import { zoneOf } from './settings.js'

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

// The configured zone first — the one the tally counts in, so the day printed
// here is the day the total under it belongs to — then UTC, which is what the
// Play Console reports and so the only way to reconcile the two by eye.
//
// A zone that resolves to UTC prints one line rather than the same instant
// twice under two names.
export function times(ms, settings) {
  const zone = zoneOf(settings)
  const out = []
  if (settings.showLocalTime) out.push(`${clock(ms, zone)} ${zoneLabel(ms, zone)}`.trim())
  if (settings.showUtcTime && zoneLabel(ms, zone) !== 'UTC') out.push(`${clock(ms, 'UTC')} UTC`)
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
  //
  // Magnitudes: a reversal can arrive with the total signed and the tax not, and
  // subtracting the two as given would make the base larger than the order ever
  // was. The fee base is a size; netBefore puts the direction back.
  return order.total.currency === order.tax.currency
    ? {
        currency: order.total.currency,
        amount: Math.abs(order.total.amount) - Math.abs(order.tax.amount),
      }
    : null
}

const reportedNet = (order) => order.payout ?? order.net

// Whether Play has actually settled the order, or the figure below is this
// module's own arithmetic on the price the buyer was charged. The caller needs
// to know which it banked: a guess has to be revisited when Play fills the real
// number in, and a reported figure does not.
export const isSettled = (order) => Boolean(reportedNet(order))

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
  // Rounded on the magnitude so a reversal lands on exactly the figure it
  // undoes: Math.round breaks .5 upwards, which would leave a charge and its
  // refund a minor unit apart and a residue behind in the running total. The
  // sign is put back by hand rather than by Math.sign, which would hand back a
  // negative zero that prints as "-0".
  const out = Math.round(Math.abs(amount) * scale) / scale
  if (out === 0) return 0
  return amount < 0 ? -out : out
}

// Reported figures first; the estimate only fills the gap, and only the gap is
// labelled as one. A settled payout used to be called an estimate too, on the
// reasoning that any figure can still move — which is true of every number
// anyone has ever been shown, and hedged the ones Play had already paid out.
//
// `fx` carries the developer's own currency and the rates read off settled
// orders. An estimate arrives in whatever the buyer paid, which is not the
// number anyone here budgets in, so it is converted whenever the pair has
// actually been observed — and left alone rather than guessed at when it has
// not.
export function estimatedNet(order, fx = {}) {
  const raw = netBefore(order)
  if (!raw) return null
  // Play usually reports the payout already in the developer's currency, in
  // which case this is a no-op. It is not a no-op when Play has filled in the
  // net but not yet the payout, and that order would otherwise print — and be
  // totalled — in a currency the developer is never paid in.
  const out = convert(raw, fx.currency, fx.rates) ?? raw
  return { currency: out.currency, amount: round(out.amount, out.currency) }
}

// Before any conversion: what Play reported, or the estimate standing in for it.
function netBefore(order) {
  const reported = reportedNet(order)
  const base = taxable(order)
  const raw =
    reported ?? (base ? { currency: base.currency, amount: base.amount * (1 - DEFAULT_FEE) } : null)
  if (!raw) return null
  // A refund is money leaving, whatever sign Play put on the figure. The state
  // is the reversal, so the direction is known from it and only the magnitude
  // has to be read out of the response. Dropping a positive figure instead kept
  // the sign beyond reproach and left the running total counting the refund as
  // nothing at all — and the total is the number the reader acts on.
  return order.state === 'refunded'
    ? { currency: raw.currency, amount: -Math.abs(raw.amount) }
    : raw
}

// Google's cut is not a fixed number — 15% or 30% depending on the programme —
// so it is derived from the order rather than assumed. `derived` is false when
// it could only be assumed, so the line can say so rather than pass the
// assumption off as a figure read out of the order.
export function feeRate(order, fx = {}) {
  const before = order.beforeFee?.amount
  const after = order.net?.amount
  if (before && after != null) {
    // Magnitudes: on a reversal Play may sign either figure, and 1 - (-3.86/4.54)
    // is 185% — a rate Google has never charged anyone.
    return { percent: Math.round((1 - Math.abs(after) / Math.abs(before)) * 100), derived: true }
  }
  // A reported figure with nothing to derive the rate from stays unexplained
  // rather than being attributed to a rate it may not have been charged.
  if (reportedNet(order)) return null
  return estimatedNet(order, fx) ? { percent: DEFAULT_FEE * 100, derived: false } : null
}

// No emoji. A line of chat that leads with a pictogram reads as an
// advertisement, and this one is a record — the word says the same thing and
// says it in the reader's own language.
function heading(order) {
  if (order.state === 'refunded') return t('notifRefund')
  const cycle = cycleOf(order)
  if (cycle == null) return t('notifNewOrder')
  return cycle > 1 ? t('notifSubRenewal', cycle) : t('notifNewSub')
}

// The id leads and the name follows in brackets. The product id is what the
// Console, the Play API and your own code all key on; the display name is the
// only part of it that can be edited later, so a name on its own leaves the
// reader guessing which SKU sold — and if it has since been renamed, unable to
// find it at all. A name identical to the id is not printed twice.
function product(order) {
  const { sku, product: name } = order
  if (sku && name && name !== sku) return `${sku}(${name})`
  return sku || name || ''
}

export function describe(order, settings, fx = {}) {
  const head = heading(order)

  // The arrow used to run charged -> payout with nothing saying what the second
  // number was; naming it is the difference between a figure and a fact.
  const net = estimatedNet(order, fx)
  const fee = feeRate(order, fx)
  // A guessed figure has to say so on the line it appears on. The breakdown is
  // off by default, so leaving the disclaimer there would hide it from almost
  // everyone — and a guess that looks like a settled payout is the one failure
  // this line cannot afford.
  //
  // The other half of that bargain is that a figure Play has settled is not
  // hedged. `derived: false` is only ever returned for an order with no reported
  // net, so the assumed label and the plain one divide exactly on whether Play
  // has paid out — which is the only question the label can usefully answer.
  const netLabel = fee && !fee.derived ? t('labelNetAssumed', fee.percent) : t('labelNet')
  const price = [money(order.total), net ? `→ ${money(net)} ${netLabel}` : '']
    .filter(Boolean)
    .join(' ')

  // Tax withheld, the rate charged, and — when the estimate crossed currencies —
  // the rate it crossed at. Between them the price line above can be recomputed,
  // which is the whole point of the setting; an undisclosed conversion would
  // leave the one reader who checks the arithmetic unable to reach the figure.
  // The net itself is not repeated here — it would be the same label twice, once
  // per currency, with nothing saying which was which.
  const crossed = rateFor(netBefore(order)?.currency, fx.currency, fx.rates)
  const breakdown =
    settings.showBreakdown && (order.tax || fee?.derived || crossed)
      ? [
          order.tax ? `${t('labelTax')} ${money(order.tax)}` : '',
          fee?.derived ? t('labelFee', fee.percent) : '',
          crossed
            ? t(
                'labelRate',
                netBefore(order).currency,
                fx.currency,
                // Significant digits, not decimal places: a KRW-to-USD rate is
                // 0.00073, and two decimals would disclose it as "0".
                crossed.toLocaleString(undefined, { maximumSignificantDigits: 6 }),
              )
            : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : ''

  // One question per line: what kind of sale, what sold and from which app, for
  // how much and where, when, and which order. Grouped that way because neither
  // half of those middle lines is worth much read on its own — an app with no
  // product, a price with no country.
  //
  // Five lines is the default shape, not a contract: the breakdown is a sixth
  // when switched on, and a line whose fields are all missing drops rather than
  // printing a bare separator. Nothing downstream may assume a fixed count.
  //
  // The commas are the requested format, spelled that way by the person who has
  // to read these every day — not a rule derived from anything. Elsewhere in
  // this module " · " still separates figures within a line.
  return [
    settings.senderName ? `[${settings.senderName}] ${head}` : head,
    [order.packageName, product(order)].filter(Boolean).join(', '),
    [order.country, price].filter(Boolean).join(', '),
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

// A running total under an order, and the same figure as an answer to /today or
// /month. One formatter for both, so the number the chat reports on request can
// never disagree with the one it volunteered.
export function totalLine(key, totals) {
  // An amount with no orders behind it is a day that was corrected by hand and
  // announced nothing; the figure is the whole point of the line, so it prints.
  if (!totals || (!totals.orders && !totals.refunds && !totals.amount)) return null
  const amount = totals.currency ? money({ currency: totals.currency, amount: totals.amount }) : ''
  // chrome.i18n has no plural forms, so the singular is its own key. Korean
  // needs none and points both at the same text.
  const n = (k, count, ...rest) => t(count === 1 ? `${k}One` : k, count, ...rest)
  // What the refunds were worth, where that is known — a count on its own leaves
  // the reader unable to tell a test purchase from the month's biggest sale.
  const back = totals.refunded
    ? n('totalRefundsAt', totals.refunds, money({ currency: totals.currency, amount: totals.refunded }))
    : n('totalRefunds', totals.refunds)
  return [
    t(totals.orders === 1 ? `${key}One` : key, amount || '—', totals.orders),
    totals.refunds ? back : '',
    // Silence here would let a currency this has never been able to convert
    // quietly shrink the total, which is the one way a running figure lies.
    totals.uncounted ? t('totalUncounted', totals.uncounted) : '',
  ]
    .filter(Boolean)
    .join(' · ')
}
