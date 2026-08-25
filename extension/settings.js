// Single source of truth for what is configurable. Both the options page and the
// service worker read defaults from here so the two can never disagree about
// what an unset field means.

export const DEFAULTS = {
  // delivery
  botToken: '',
  chatId: '',
  senderName: '',

  // source
  consoleUrl: '',
  developerId: '',

  // what to notify
  notifyCharged: true,
  notifyRefunded: true,
  packages: '',
  minPayout: 0,

  // message format
  showLocalTime: true,
  showUtcTime: true,
  showBreakdown: false,
  showDailyTotal: true,

  // questions
  //
  // A URL rather than a brand, because the shape below it is the same nearly
  // everywhere now. The defaults are the cheapest thing that works out of the
  // box; changing them points this at OpenAI, at a gateway, or at something on
  // the user's own machine.
  aiKey: '',
  aiBaseUrl: 'https://api.deepseek.com',
  aiModel: 'deepseek-v4-flash',

  // schedule
  intervalMinutes: 10,
  days: 2,
  verbose: false,
}

export const load = () => chrome.storage.local.get(DEFAULTS)

// Users have a Console URL in front of them, not a developer id, so the id is
// derived rather than asked for.
export function developerIdFrom(url) {
  return /\/developers\/(\d{5,})/.exec(String(url ?? ''))?.[1] ?? ''
}

export const isConfigured = (s) => Boolean(s.botToken && s.chatId && s.developerId)

// Lets a stored developer id be shown back as the URL it was derived from, so
// the options form round-trips instead of clearing the id it cannot see.
export const consoleUrlFor = (id) =>
  id ? `https://play.google.com/console/u/0/developers/${id}/orders` : ''

// Number('') is 0 — finite — so testing the parsed value alone makes a fallback
// unreachable and turns a cleared field into the range minimum.
export function clampNumber(raw, [lo, hi], fallback) {
  const text = String(raw ?? '').trim()
  const n = Number(text)
  if (text === '' || !Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

export function packageList(packages) {
  return String(packages ?? '')
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean)
}
