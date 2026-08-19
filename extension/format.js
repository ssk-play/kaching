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

// Google's cut is not a fixed number — 15% or 30% depending on the programme —
// so it is derived from the order rather than assumed.
export function feePercent(order) {
  const before = order.beforeFee?.amount
  const after = order.net?.amount
  if (!before || after == null) return null
  return Math.round((1 - after / before) * 100)
}

export function describe(order, settings) {
  const head =
    order.state === 'refunded'
      ? `↩️ ${t('notifRefund')}`
      : order.subscription
        ? `🔔 ${t('notifNewSub')}`
        : `🔔 ${t('notifNewOrder')}`

  // The arrow used to run charged -> payout with nothing saying what the second
  // number was; naming it is the difference between a figure and a fact.
  const net = order.payout ?? order.net
  const price = [money(order.total), net ? `→ ${money(net)} ${t('labelNet')}` : '']
    .filter(Boolean)
    .join(' ')

  const fee = feePercent(order)
  const breakdown =
    settings.showBreakdown && order.tax
      ? [
          `${t('labelTax')} ${money(order.tax)}`,
          fee == null ? '' : t('labelFee', fee),
          order.net ? `${t('labelNet')} ${money(order.net)}` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : ''

  return [
    settings.senderName ? `[${settings.senderName}] ${head}` : head,
    order.product,
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
