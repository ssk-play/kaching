// Renders the real options page outside an extension host: i18n comes from the
// shipped catalogue, storage returns sample values. Screenshot fidelity depends
// on this being the actual options.html/js, not a mock-up of them.
//
// This module imports options.js itself at the end rather than letting the page
// carry a second <script> tag. Two sibling module scripts are separate graphs,
// so the top-level await below does not hold the second one back — options.js
// would race ahead and read an i18n catalogue that has not loaded, rendering
// every label as an empty string.
const messages = await (await fetch('../../extension/_locales/en/messages.json')).json()
const SAMPLE = {
  botToken: '0000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  chatId: '123456789',
  senderName: '',
  consoleUrl: 'https://play.google.com/console/u/0/developers/1234567890/orders',
  developerId: '1234567890',
  notifyCharged: true,
  notifyRefunded: true,
  packages: '',
  minPayout: 1,
  showLocalTime: false,
  showUtcTime: true,
  intervalMinutes: 10,
  days: 2,
  verbose: false,
}
const now = Date.parse('2026-08-19T14:22:00')
const SAMPLE_LOG = [
  { at: now - 5400e3, level: 'info',  key: 'logFirstSync', args: ['128'] },
  { at: now - 3600e3, level: 'info',  key: 'logCheckNone', args: ['12'] },
  { at: now - 1800e3, level: 'order', key: 'logOrder', args: ['Premium (AirPlay Touch)', 'charged'] },
  { at: now - 1790e3, level: 'info',  key: 'logCheckNew', args: ['1', '13'] },
  { at: now - 900e3,  level: 'error', key: 'logFail', args: ['auth', '1'] },
  { at: now - 600e3,  level: 'info',  key: 'logRecovered', args: [] },
  { at: now - 300e3,  level: 'order', key: 'logOrder', args: ['Premium Subscription', 'refunded'] },
  { at: now - 290e3,  level: 'info',  key: 'logCheckNew', args: ['1', '14'] },
]
globalThis.chrome = {
  i18n: {
    getMessage: (key, subs = []) =>
      (messages[key]?.message ?? '').replace(/\$(\d)/g, (_, n) => subs[Number(n) - 1] ?? ''),
  },
  storage: {
    local: { get: async (d) => ({ ...d, ...SAMPLE, ...('log' in d ? { log: SAMPLE_LOG } : {}) }), set: async () => {} },
    onChanged: { addListener: () => {} },
  },
  runtime: {
    sendMessage: async ({ type }) =>
      type === 'status'
        ? { ok: true, result: { scheduled: 'Checking every 10 min — next at 14:32', configured: true, recorded: 128, consecutiveFailures: 0, lastSuccess: '2026-08-19 14:22' } }
        : { ok: true, result: {} },
  },
}

// Ordering, not decoration: everything above must exist before options.js runs.
await import('./options.js')
