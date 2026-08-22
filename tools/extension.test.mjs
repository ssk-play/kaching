// Unit tests for the parts of the extension that hold real logic. Kept outside
// extension/ so they are not shipped in the store package.
//
// Run: node --test tools/extension.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension')
const messages = JSON.parse(fs.readFileSync(path.join(EXT, '_locales/en/messages.json'), 'utf8'))

// Stub only what these modules touch, and back i18n with the real catalogue so a
// renamed or missing key fails here rather than in the store build.
globalThis.chrome = {
  i18n: {
    getMessage: (key, subs = []) => {
      const raw = messages[key]?.message
      assert.ok(raw !== undefined, `missing i18n key: ${key}`)
      return raw.replace(/\$(\d)/g, (_, n) => subs[Number(n) - 1] ?? '')
    },
  },
}

// Absolute paths must be file: URLs for dynamic import.
const load = (f) => import(pathToFileURL(path.join(EXT, f)).href)
const { DEFAULTS, developerIdFrom, packageList, isConfigured, consoleUrlFor, clampNumber } =
  await load('settings.js')
const { matches, plan } = await load('filters.js')
const { times, describe, feeRate, cycleOf, estimatedNet } = await load('format.js')
const { shouldAlert, FAILS_BEFORE_ALERT, ALERT_COOLDOWN_MS } = await load('health.js')
const { ratesFrom, merge, payoutCurrency, convert, rateFor } = await load('fx.js')
const T = await load('totals.js')
const { chatsIn } = await load('telegram.js')
const { totalLine } = await load('format.js')
const { trim, MAX_ENTRIES } = await load('log.js')

const order = (over = {}) => ({
  id: 'GPA.1111-2222-3333-44444',
  state: 'charged',
  subscription: false,
  product: 'Premium',
  sku: 'premium_unlock',
  packageName: 'com.example.app',
  country: 'KR',
  total: { currency: 'USD', amount: 4.99 },
  beforeFee: { currency: 'USD', amount: 4.54 },
  tax: { currency: 'USD', amount: 0.45 },
  net: { currency: 'USD', amount: 3.86 },
  payout: { currency: 'KRW', amount: 6500 },
  at: Date.UTC(2026, 7, 18, 23, 40),
  ...over,
})

test('developerIdFrom reads the id out of a Console URL', () => {
  assert.equal(
    developerIdFrom('https://play.google.com/console/u/0/developers/9876543210987654321/orders'),
    '9876543210987654321',
  )
  assert.equal(developerIdFrom('https://play.google.com/console/u/2/developers/12345/app/x'), '12345')
  assert.equal(developerIdFrom('https://play.google.com/console/'), '')
  assert.equal(developerIdFrom(''), '')
  assert.equal(developerIdFrom(undefined), '')
})

test('packageList tolerates the separators users actually type', () => {
  assert.deepEqual(packageList('a.b, c.d'), ['a.b', 'c.d'])
  assert.deepEqual(packageList(' a.b \n c.d '), ['a.b', 'c.d'])
  assert.deepEqual(packageList(''), [])
  assert.deepEqual(packageList(undefined), [])
})

test('isConfigured requires all three of token, chat and developer id', () => {
  assert.equal(isConfigured({ botToken: 't', chatId: 'c', developerId: 'd' }), true)
  assert.equal(isConfigured({ botToken: 't', chatId: 'c', developerId: '' }), false)
  assert.equal(isConfigured({ botToken: '', chatId: 'c', developerId: 'd' }), false)
})

test('state toggles gate their own event only', () => {
  const s = { ...DEFAULTS, notifyRefunded: false }
  assert.equal(matches(order(), s), true)
  assert.equal(matches(order({ state: 'refunded' }), s), false)

  const r = { ...DEFAULTS, notifyCharged: false }
  assert.equal(matches(order(), r), false)
  assert.equal(matches(order({ state: 'refunded' }), r), true)
})

test('empty package filter means every app', () => {
  assert.equal(matches(order(), { ...DEFAULTS, packages: '' }), true)
  assert.equal(matches(order(), { ...DEFAULTS, packages: 'com.example.app' }), true)
  assert.equal(matches(order(), { ...DEFAULTS, packages: 'com.other' }), false)
  assert.equal(matches(order(), { ...DEFAULTS, packages: 'com.other, com.example.app' }), true)
})

test('minPayout of zero notifies everything, one hides free test orders', () => {
  const free = order({ total: { currency: 'KRW', amount: 0 }, payout: { currency: 'KRW', amount: 0 } })
  assert.equal(matches(free, { ...DEFAULTS, minPayout: 0 }), true)
  assert.equal(matches(free, { ...DEFAULTS, minPayout: 1 }), false)
  assert.equal(matches(order(), { ...DEFAULTS, minPayout: 1 }), true)
})

test('minPayout falls back to the buyer total when no payout is settled', () => {
  const unsettled = order({ payout: null })
  assert.equal(matches(unsettled, { ...DEFAULTS, minPayout: 4 }), true)
  assert.equal(matches(unsettled, { ...DEFAULTS, minPayout: 5 }), false)
})

test('time toggles select zones independently', () => {
  const at = Date.UTC(2026, 7, 18, 23, 40)
  assert.equal(times(at, { showLocalTime: false, showUtcTime: true }), '2026-08-18 23:40 UTC')
  assert.match(times(at, { showLocalTime: true, showUtcTime: false }), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  assert.match(times(at, { showLocalTime: true, showUtcTime: true }), / \/ 2026-08-18 23:40 UTC$/)
  // Both off is a choice, not an error: the line disappears.
  assert.equal(times(at, { showLocalTime: false, showUtcTime: false }), '')
})

test('describe omits the sender label when it is blank', () => {
  const bare = describe(order(), { ...DEFAULTS, senderName: '' })
  assert.ok(bare.startsWith('🔔 New order'), bare)
  const tagged = describe(order(), { ...DEFAULTS, senderName: 'shop' })
  assert.ok(tagged.startsWith('[shop] 🔔 New order'), tagged)
})

test('describe distinguishes refunds and subscriptions', () => {
  assert.ok(describe(order({ state: 'refunded' }), DEFAULTS).startsWith('↩️ Refund'))
  assert.ok(describe(order({ subscription: true }), DEFAULTS).startsWith('🔔 New subscription'))
})

test('describe drops empty lines rather than printing blanks', () => {
  const sparse = describe(
    order({ country: '', total: null, payout: null, net: null, tax: null, beforeFee: null }),
    { ...DEFAULTS, showLocalTime: false, showUtcTime: false },
  )
  assert.ok(!sparse.includes('\n\n'), sparse)
  assert.deepEqual(sparse.split('\n'), ['🔔 New order', 'Premium · premium_unlock', 'com.example.app', order().id])
})

test('clampNumber falls back for blank input instead of clamping to the minimum', () => {
  // Number('') is 0 and finite; testing the parsed value alone silently turned a
  // cleared "check every" box into a 1-minute poll.
  assert.equal(clampNumber('', [1, 120], 10), 10)
  assert.equal(clampNumber('   ', [1, 120], 10), 10)
  assert.equal(clampNumber('abc', [1, 120], 10), 10)
  assert.equal(clampNumber(undefined, [1, 120], 10), 10)
  assert.equal(clampNumber('0', [1, 120], 10), 1)
  assert.equal(clampNumber('999', [1, 120], 10), 120)
  assert.equal(clampNumber('7', [1, 120], 10), 7)
})

test('a stored developer id round-trips through the URL field', () => {
  // An install predating the URL field would otherwise have its id wiped the
  // first time Save was pressed.
  const id = '9876543210987654321'
  assert.equal(developerIdFrom(consoleUrlFor(id)), id)
  assert.equal(consoleUrlFor(''), '')
  assert.equal(developerIdFrom(consoleUrlFor('')), '')
})

// plan() decides send order and what may be written off without being sent.
// These rules are easy to get subtly wrong and were, twice.
const orders = (n, over = {}) =>
  Array.from({ length: n }, (_, i) => order({ id: `GPA.0000-0000-0000-0000${i}`, ...over }))

test('plan sends oldest first within the batch', () => {
  // The API returns newest first; a burst should read in the order it happened.
  const page = orders(3)
  const { batch } = plan(page, [], DEFAULTS, 10)
  assert.deepEqual(batch.map((o) => o.id), [page[2].id, page[1].id, page[0].id])
})

test('plan separates the overflow tail from the batch instead of dropping it', () => {
  const page = orders(15)
  const { batch, overflow, freshCount } = plan(page, [], DEFAULTS, 10)
  assert.equal(batch.length, 10)
  assert.equal(overflow.length, 5)
  assert.equal(freshCount, 15)
  // Every fresh order is accounted for in exactly one bucket.
  const ids = new Set([...batch, ...overflow].map((o) => o.id))
  assert.equal(ids.size, 15)
})

test('plan puts filter-muted orders in muted, never in batch or overflow', () => {
  const page = [order({ id: 'GPA.0000-0000-0000-00001' }), order({ id: 'GPA.0000-0000-0000-00002', packageName: 'com.other' })]
  const { batch, overflow, muted, freshCount, unseenCount } = plan(
    page, [], { ...DEFAULTS, packages: 'com.example.app' }, 10,
  )
  assert.deepEqual(muted.map((o) => o.packageName), ['com.other'])
  assert.equal(batch.length, 1)
  assert.equal(overflow.length, 0)
  assert.equal(freshCount, 1)
  assert.equal(unseenCount, 2)
})

test('plan skips orders already recorded as seen', () => {
  const page = orders(3)
  const seen = [`${page[0].id}:charged`]
  const { batch, unseenCount } = plan(page, seen, DEFAULTS, 10)
  assert.equal(unseenCount, 2)
  assert.ok(!batch.some((o) => o.id === page[0].id))
})

test('plan treats a refund of a seen order as new', () => {
  // The dedupe key carries state, so a refund on an announced order re-fires.
  const charged = order({ id: 'GPA.0000-0000-0000-00009' })
  const refunded = order({ id: 'GPA.0000-0000-0000-00009', state: 'refunded' })
  const { batch } = plan([refunded], [`${charged.id}:charged`], DEFAULTS, 10)
  assert.equal(batch.length, 1)
  assert.equal(batch[0].state, 'refunded')
})

// This policy has been wrong in both directions across two review rounds, so it
// is pinned here rather than left to inspection.
test('shouldAlert stays quiet below the failure threshold', () => {
  const now = 1_000_000_000
  for (let f = 0; f < FAILS_BEFORE_ALERT; f++) assert.equal(shouldAlert(f, 0, now), false)
  assert.equal(shouldAlert(FAILS_BEFORE_ALERT, 0, now), true)
})

test('shouldAlert rate-limits a continuing outage to one alert per cooldown', () => {
  const sent = 500_000
  assert.equal(shouldAlert(4, sent, sent + 1000), false)
  assert.equal(shouldAlert(9, sent, sent + ALERT_COOLDOWN_MS), false)
  assert.equal(shouldAlert(4, sent, sent + ALERT_COOLDOWN_MS + 1), true)
})

test('shouldAlert still fires for a later outage the same day', () => {
  // Never clearing the cooldown once muted the second outage for 24 hours.
  const morning = 0
  assert.equal(shouldAlert(FAILS_BEFORE_ALERT, morning, ALERT_COOLDOWN_MS + 1), true)
})

test('shouldAlert cannot be re-armed by an intervening success', () => {
  // Clearing lastAlertAt on every success made the cooldown unreachable: a
  // flapping session then alerted every few polls, forever.
  const sent = 1_000_000
  const afterFlap = sent + 60_000 // fail,fail,fail -> success -> fail,fail,fail
  assert.equal(shouldAlert(FAILS_BEFORE_ALERT, sent, afterFlap), false)
})

test('the activity log keeps the newest entries when it overflows', () => {
  const entries = Array.from({ length: MAX_ENTRIES + 50 }, (_, i) => ({ at: i, key: 'logCheckNone' }))
  const kept = trim(entries)
  assert.equal(kept.length, MAX_ENTRIES)
  // Oldest dropped, newest retained — the log answers "what just happened".
  assert.equal(kept.at(-1).at, entries.at(-1).at)
  assert.equal(kept[0].at, 50)
})

test('trim leaves a short log untouched', () => {
  const entries = [{ at: 1 }, { at: 2 }]
  assert.deepEqual(trim(entries), entries)
  assert.deepEqual(trim([]), [])
})

test('feeRate is derived from the order, not assumed', () => {
  // Google takes 15% or 30% depending on the programme, so it has to be read
  // back out of the figures rather than hardcoded.
  assert.deepEqual(feeRate(order()), { percent: 15, derived: true })
  assert.deepEqual(
    feeRate(order({ beforeFee: { currency: 'USD', amount: 10 }, net: { currency: 'USD', amount: 7 } })),
    { percent: 30, derived: true },
  )
  assert.equal(feeRate(order({ beforeFee: null })), null)
  assert.equal(feeRate(order({ beforeFee: { currency: 'KRW', amount: 0 }, net: { currency: 'KRW', amount: 0 } })), null)
})

test('the payout line says what the second figure is', () => {
  // It used to read "USD 4.99 -> KRW 6,500" with nothing naming the second
  // number, which left the net indistinguishable from the charge.
  const line = describe(order(), DEFAULTS).split('\n').find((l) => l.includes('→'))
  assert.match(line, /USD 4\.99 → KRW 6,500 est\. net$/)
})

test('the breakdown line appears only when asked for', () => {
  const off = describe(order(), { ...DEFAULTS, showBreakdown: false })
  assert.ok(!off.includes('fee 15%'), off)
  const on = describe(order(), { ...DEFAULTS, showBreakdown: true })
  // Tax and rate only: repeating the net would print the same label twice, once
  // per currency, with nothing saying which was the payout.
  assert.ok(on.includes('tax USD 0.45 · fee 15%'), on)
  assert.equal(on.match(/est\. net/g).length, 1, on)
})

test('an order with no tax figures still renders without an empty line', () => {
  const bare = describe(order({ tax: null, beforeFee: null, net: null }), {
    ...DEFAULTS,
    showBreakdown: true,
  })
  assert.ok(!bare.includes('\n\n'), bare)
})

test('a subscription renewal is not announced as a new subscription', () => {
  // Play appends "..N" to the base order id from the first renewal onwards, so
  // the charge number is readable off the id itself.
  assert.equal(cycleOf(order({ subscription: true })), 1)
  assert.equal(cycleOf(order({ subscription: true, id: 'GPA.1111-2222-3333-44444..0' })), 2)
  assert.equal(cycleOf(order({ subscription: true, id: 'GPA.1111-2222-3333-44444..11' })), 13)
  // A one-time purchase has no cycle at all, suffix or not.
  assert.equal(cycleOf(order({ id: 'GPA.1111-2222-3333-44444..0' })), null)

  const renewal = describe(order({ subscription: true, id: 'GPA.1111-2222-3333-44444..2' }), DEFAULTS)
  assert.ok(renewal.startsWith('🔁 Subscription renewal · charge #4'), renewal)
  assert.ok(describe(order({ subscription: true }), DEFAULTS).startsWith('🔔 New subscription'))
  // A refund stays a refund whatever charge it undoes.
  assert.ok(
    describe(order({ subscription: true, state: 'refunded', id: 'GPA.1..0' }), DEFAULTS)
      .startsWith('↩️ Refund'),
  )
})

test('an unsettled order still shows an estimated net', () => {
  // Play reports no net or payout until it settles, which used to drop the line
  // from one-time purchases entirely.
  const unsettled = { payout: null, net: null }
  assert.deepEqual(estimatedNet(order(unsettled)), { currency: 'USD', amount: 3.86 })
  // Without beforeFee the fee applies to the price with tax taken out.
  assert.deepEqual(estimatedNet(order({ ...unsettled, beforeFee: null })), {
    currency: 'USD',
    amount: 3.86,
  })
  // Tax that cannot be subtracted would leave a figure the breakdown beside it
  // contradicts, so nothing is printed rather than something that fails the check.
  assert.equal(
    estimatedNet(order({ ...unsettled, beforeFee: null, tax: { currency: 'KRW', amount: 600 } })),
    null,
  )
  // No tax at all means the charge already is the base.
  assert.deepEqual(estimatedNet(order({ ...unsettled, beforeFee: null, tax: null })), {
    currency: 'USD',
    amount: 4.24,
  })
  // Nothing to work from stays nothing rather than becoming a zero.
  assert.equal(estimatedNet(order({ ...unsettled, beforeFee: null, total: null })), null)

  const line = describe(order(unsettled), DEFAULTS).split('\n').find((l) => l.includes('→'))
  assert.match(line, /USD 4\.99 → USD 3\.86 est\. net · 15% fee assumed$/)
})

test('an estimated net says on its own line that the rate was assumed', () => {
  const unsettled = { payout: null, net: null }
  assert.deepEqual(feeRate(order(unsettled)), { percent: 15, derived: false })

  // The breakdown is off by default, so the disclaimer has to survive DEFAULTS:
  // a guess that reads like a settled payout is the failure that matters.
  const plain = describe(order(unsettled), DEFAULTS)
  assert.ok(plain.includes('USD 3.86 est. net · 15% fee assumed'), plain)
  // A tax figure is not what makes an estimate an estimate.
  const noTax = describe(order({ ...unsettled, tax: null, beforeFee: null }), DEFAULTS)
  assert.ok(noTax.includes('USD 4.24 est. net · 15% fee assumed'), noTax)

  // A settled figure is Play's own and carries no such qualifier.
  assert.ok(!describe(order(), DEFAULTS).includes('assumed'), describe(order(), DEFAULTS))

  // The breakdown never restates an assumed rate as if it were read off the order.
  const on = describe(order(unsettled), { ...DEFAULTS, showBreakdown: true })
  assert.ok(on.includes('tax USD 0.45'), on)
  assert.ok(!on.includes('fee 15%'), on)
})
test('a refund is never given an estimated net', () => {
  // Refunds arrive long before Play settles the reversal, so the estimate would
  // fire on exactly the orders where a positive figure is most misleading.
  const unsettled = { state: 'refunded', payout: null, net: null }
  assert.equal(estimatedNet(order(unsettled)), null)
  assert.equal(feeRate(order(unsettled)), null)
  const text = describe(order(unsettled), { ...DEFAULTS, showBreakdown: true })
  assert.ok(!text.includes('est. net'), text)
  assert.ok(!text.includes('%'), text)
  assert.ok(text.includes('USD 4.99'), text)
  // A settled reversal is no different: Play reporting a positive payout on a
  // refund does not make it income, and negating it would invent a sign the
  // response never carried.
  assert.equal(estimatedNet(order({ state: 'refunded' })), null)
  // A figure Play itself signs as leaving is worth showing.
  assert.deepEqual(
    estimatedNet(order({ state: 'refunded', payout: { currency: 'KRW', amount: -6500 } })),
    { currency: 'KRW', amount: -6500 },
  )
})

test('the breakdown states a derived rate even where no tax was withheld', () => {
  // With the net no longer repeated here, the rate is the only thing this line
  // still contributes — gating it on tax hid it in every tax-free jurisdiction.
  const noTax = describe(
    order({ tax: null, beforeFee: { currency: 'USD', amount: 4.99 }, net: { currency: 'USD', amount: 3.49 } }),
    { ...DEFAULTS, showBreakdown: true },
  )
  assert.ok(noTax.includes('fee 30%'), noTax)
  assert.ok(!noTax.includes('tax'), noTax)
  assert.ok(!noTax.includes('\n\n'), noTax)
})

test('an estimate is rounded to the currency it is quoted in', () => {
  // KRW and JPY have no minor unit, so a raw 0.85x lands on an amount that
  // cannot exist — and Korean developers are the ones who would see it most.
  const krw = estimatedNet(
    order({
      payout: null, net: null, beforeFee: null,
      total: { currency: 'KRW', amount: 5900 },
      tax: { currency: 'KRW', amount: 536 },
    }),
  )
  assert.deepEqual(krw, { currency: 'KRW', amount: 4559 })
  // Currencies that do have cents keep them.
  assert.deepEqual(estimatedNet(order({ payout: null, net: null })), {
    currency: 'USD',
    amount: 3.86,
  })
})

test('the product ID rides along with the display name', () => {
  // The name is editable in the Console; the ID is what every API and every
  // line of the developer's own code keys on.
  assert.ok(describe(order(), DEFAULTS).includes('Premium · premium_unlock'))
  // Nothing to add is not the same as something to repeat.
  assert.ok(describe(order({ sku: 'Premium' }), DEFAULTS).includes('\nPremium\n'))
  assert.ok(describe(order({ sku: '' }), DEFAULTS).includes('\nPremium\n'))
})

test('the exchange rate is read off orders Play has already settled', () => {
  // Both figures ride on every settled order, so the rate is in hand without
  // calling anything — which an extension that promises nothing leaves the
  // browser could not do anyway.
  const settled = [
    { state: 'charged', at: 2, net: { currency: 'NOK', amount: 64.6 }, payout: { currency: 'KRW', amount: 9633 } },
    { state: 'charged', at: 1, net: { currency: 'USD', amount: 1.69 }, payout: { currency: 'KRW', amount: 2354 } },
    // Nothing to learn from these.
    { state: 'charged', at: 3, net: null, payout: { currency: 'KRW', amount: 10 } },
    { state: 'charged', at: 4, net: { currency: 'KRW', amount: 5 }, payout: { currency: 'KRW', amount: 5 } },
  ]
  const rates = ratesFrom(settled)
  assert.deepEqual(Object.keys(rates).sort(), ['NOK>KRW', 'USD>KRW'])
  assert.ok(Math.abs(rates['NOK>KRW'] - 9633 / 64.6) < 1e-9)
  assert.equal(rates['KRW>KRW'], undefined)

  assert.equal(payoutCurrency(settled), 'KRW')
  assert.equal(payoutCurrency([]), null)

  // Yesterday's rate survives a day when nothing settled in that currency.
  assert.deepEqual(merge({ 'JPY>KRW': 9 }, { 'USD>KRW': 1300 }), { 'JPY>KRW': 9, 'USD>KRW': 1300 })
  assert.deepEqual(merge({ 'USD>KRW': 1200 }, { 'USD>KRW': 1300 }), { 'USD>KRW': 1300 })
})

test('an unobserved currency pair is left alone rather than guessed at', () => {
  const rates = { 'USD>KRW': 1300 }
  assert.deepEqual(convert({ currency: 'USD', amount: 2 }, 'KRW', rates), {
    currency: 'KRW',
    amount: 2600,
  })
  // Already there.
  assert.deepEqual(convert({ currency: 'KRW', amount: 5 }, 'KRW', rates), { currency: 'KRW', amount: 5 })
  // Never seen: null, so the caller keeps the buyer-currency figure.
  assert.equal(convert({ currency: 'NOK', amount: 10 }, 'KRW', rates), null)
  assert.equal(convert(null, 'KRW', rates), null)
  assert.equal(convert({ currency: 'USD', amount: 2 }, null, rates), null)
})

test('an estimate is converted into the currency the developer is paid in', () => {
  // The whole complaint: a figure in the buyer's currency is not the number
  // anyone budgets in.
  const fx = { currency: 'KRW', rates: { 'USD>KRW': 1300 } }
  const unsettled = order({ payout: null, net: null })
  // 4.54 x 0.85 x 1300, rounded once at the end rather than twice.
  assert.deepEqual(estimatedNet(unsettled, fx), { currency: 'KRW', amount: 5017 })
  // Rounded to KRW's own unit, not carried at USD precision.
  assert.equal(Number.isInteger(estimatedNet(unsettled, fx).amount), true)

  const line = describe(unsettled, DEFAULTS, fx).split('\n').find((l) => l.includes('→'))
  assert.match(line, /USD 4\.99 → KRW 5,017 est\. net · 15% fee assumed$/)

  // No rate for the pair: the buyer-currency figure stands rather than a guess.
  assert.deepEqual(estimatedNet(unsettled, { currency: 'KRW', rates: {} }), {
    currency: 'USD',
    amount: 3.86,
  })
  // A settled order is Play's own payout and is never touched by any of this.
  assert.deepEqual(estimatedNet(order(), fx), { currency: 'KRW', amount: 6500 })
})

test('the newest settled order sets the rate, whatever order they arrive in', () => {
  // fetchOrders returns newest first, so keeping the last match would have kept
  // the oldest rate in the window — and re-learned it on every poll.
  const newest = { state: 'charged', at: 200, net: { currency: 'USD', amount: 1 }, payout: { currency: 'KRW', amount: 1400 } }
  const oldest = { state: 'charged', at: 100, net: { currency: 'USD', amount: 1 }, payout: { currency: 'KRW', amount: 1200 } }
  assert.equal(ratesFrom([newest, oldest])['USD>KRW'], 1400)
  assert.equal(ratesFrom([oldest, newest])['USD>KRW'], 1400)
})

test('a rate is never learned from a reversal or stored negative', () => {
  // Play's sign convention on a refund is not something to bet the whole
  // currency pair on: one mismatch would turn every later sale into money out.
  const refund = { state: 'refunded', at: 300, net: { currency: 'USD', amount: 3.86 }, payout: { currency: 'KRW', amount: -5300 } }
  assert.deepEqual(ratesFrom([refund]), {})
  const wrong = { state: 'charged', at: 300, net: { currency: 'USD', amount: 3.86 }, payout: { currency: 'KRW', amount: -5300 } }
  assert.deepEqual(ratesFrom([wrong]), {})
  // And a negative rate already in storage is refused on the way out.
  assert.equal(rateFor('USD', 'KRW', { 'USD>KRW': -1300 }), null)
  assert.equal(convert({ currency: 'USD', amount: 2 }, 'KRW', { 'USD>KRW': -1300 }), null)
})

test('a conversion states the rate it crossed at', () => {
  // Otherwise the breakdown cannot be reconciled with the price line, which is
  // the only reason the setting exists.
  const fx = { currency: 'KRW', rates: { 'USD>KRW': 1300 } }
  const text = describe(order({ payout: null, net: null }), { ...DEFAULTS, showBreakdown: true }, fx)
  assert.ok(text.includes('KRW 5,017 est. net'), text)
  assert.ok(text.includes('USD→KRW 1,300'), text)
  // Nothing crossed, nothing to disclose.
  const same = describe(order(), { ...DEFAULTS, showBreakdown: true }, fx)
  assert.ok(!same.includes('→KRW 1,300'), same)
})

test('a day is the developer\'s day, not UTC', () => {
  // A sale at 08:40 in Seoul belongs to that morning. A UTC key would file it
  // against the day before and make the footer disagree with the timestamp
  // printed directly above it.
  const ms = Date.UTC(2026, 7, 18, 23, 40)
  assert.equal(T.dayKey(ms, 'Asia/Seoul'), '2026-08-19')
  assert.equal(T.dayKey(ms, 'UTC'), '2026-08-18')
  assert.equal(T.monthKey('2026-08-19'), '2026-08')
})

test('totals sum a day and a month from the same buckets', () => {
  let b = {}
  const krw = (amount) => ({ currency: 'KRW', amount })
  b = T.record(b, '2026-08-19', { net: krw(5000), currency: 'KRW' })
  b = T.record(b, '2026-08-19', { net: krw(3000), currency: 'KRW' })
  b = T.record(b, '2026-08-20', { net: krw(1000), currency: 'KRW' })
  b = T.record(b, '2026-07-31', { net: krw(9999), currency: 'KRW' })

  assert.deepEqual(T.sum(b, '2026-08-19'), { currency: 'KRW', amount: 8000, orders: 2, refunds: 0, uncounted: 0 })
  // Same function answers the month, so the two figures cannot drift apart.
  assert.equal(T.sum(b, '2026-08').amount, 9000)
  assert.equal(T.sum(b, '2026-08').orders, 3)
  assert.equal(T.sum(b, '2026-09').orders, 0)
})

test('a total never quietly absorbs money it could not convert', () => {
  // Adding NOK to a KRW total would produce a number that looks right and is
  // not, so it is counted apart and the line says so.
  let b = T.record({}, '2026-08-19', { net: { currency: 'NOK', amount: 64.6 }, currency: 'KRW' })
  assert.deepEqual(T.sum(b, '2026-08-19'), { currency: 'KRW', amount: 0, orders: 1, refunds: 0, uncounted: 1 })
  // A refund is counted, never added.
  b = T.record(b, '2026-08-19', { net: null, refund: true, currency: 'KRW' })
  assert.equal(T.sum(b, '2026-08-19').refunds, 1)
  assert.equal(T.sum(b, '2026-08-19').amount, 0)
})

test('buckets are bounded so a year of history cannot grow without limit', () => {
  const many = Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => [`2026-01-0${i + 1}`, { currency: 'KRW', amount: i, orders: 1, refunds: 0, uncounted: 0 }]),
  )
  const kept = T.trim(many, 3)
  // Oldest dropped, newest kept — ISO keys sort chronologically, which is the
  // whole reason for that format.
  assert.deepEqual(Object.keys(kept), ['2026-01-03', '2026-01-04', '2026-01-05'])
  assert.deepEqual(T.trim(many, 5), many)
})

test('one formatter draws both the footer and the /today answer', () => {
  // Same function, same buckets, same prefix rules — so the figure the chat
  // volunteers under an order cannot disagree with the one it reports when
  // asked. Only the leading word differs.
  const totals = { currency: 'KRW', amount: 8000, orders: 2, refunds: 1, uncounted: 0 }
  assert.equal(totalLine('totalToday', totals), 'Today KRW 8,000 · 2 orders · 1 refund')
  assert.equal(totalLine('totalMonth', totals), 'This month KRW 8,000 · 2 orders · 1 refund')
  assert.equal(
    totalLine('totalToday', totals).replace('Today', ''),
    totalLine('totalMonth', totals).replace('This month', ''),
  )
  // Nothing yet is nothing to say under an order; the query path supplies its
  // own zero line instead.
  assert.equal(totalLine('totalToday', { currency: null, amount: 0, orders: 0, refunds: 0, uncounted: 0 }), null)
  assert.equal(totalLine('totalToday', null), null)
  assert.ok(totalLine('totalToday', { ...totals, uncounted: 2 }).endsWith('2 not converted'))
})

test('English counts read right at one, not "1 orders"', () => {
  // The default footer means the first order of every single day would have
  // shown it — chrome.i18n has no plural forms, so the singular is its own key.
  const one = { currency: 'KRW', amount: 5020, orders: 1, refunds: 1, uncounted: 0 }
  assert.equal(totalLine('totalToday', one), 'Today KRW 5,020 · 1 order · 1 refund')
  assert.equal(totalLine('totalMonth', one), 'This month KRW 5,020 · 1 order · 1 refund')
})

test('a rate below 1 is disclosed as a number, not as zero', () => {
  // A developer paid in USD whose buyers pay in KRW: two decimal places would
  // print the rate as "0" on the line that exists to make the net checkable.
  const fx = { currency: 'USD', rates: { 'KRW>USD': 0.00073 } }
  const krw = order({
    payout: null, net: null, beforeFee: null, tax: null,
    total: { currency: 'KRW', amount: 12000 },
  })
  const text = describe(krw, { ...DEFAULTS, showBreakdown: true }, fx)
  assert.ok(text.includes('KRW→USD 0.00073'), text)
  assert.ok(text.includes('USD 7.45 est. net'), text)
})

test('a net Play reported but has not converted still lands in the payout currency', () => {
  // Field 27 filled, field 28 not yet: without this the order printed — and was
  // totalled — in a currency the developer is never paid in.
  const fx = { currency: 'KRW', rates: { 'USD>KRW': 1300 } }
  const half = order({ payout: null })
  assert.deepEqual(estimatedNet(half, fx), { currency: 'KRW', amount: 5018 })
  // Play's own payout is already there and is left exactly as reported.
  assert.deepEqual(estimatedNet(order(), fx), { currency: 'KRW', amount: 6500 })
  // No rate for the pair: the reported figure stands rather than a guess.
  assert.deepEqual(estimatedNet(half, { currency: 'KRW', rates: {} }), {
    currency: 'USD',
    amount: 3.86,
  })
})

test('chats are recognised from both private messages and channel posts', () => {
  // Find chat ID has to keep working after a poll has acknowledged the update
  // that named the chat, so the poller banks chats in this same shape.
  const list = [
    { update_id: 1, message: { chat: { id: 111, first_name: 'Ada' }, text: '/today' } },
    { update_id: 2, channel_post: { chat: { id: -222, title: 'Sales' }, text: 'hi' } },
    // Same chat twice is one entry.
    { update_id: 3, message: { chat: { id: 111, first_name: 'Ada' }, text: 'hi' } },
    { update_id: 4 },
  ]
  assert.deepEqual(chatsIn(list), [
    { id: 111, name: 'Ada' },
    { id: -222, name: 'Sales' },
  ])
  assert.deepEqual(chatsIn([]), [])
})
