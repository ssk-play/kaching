// One substitution helper for every context. Defining it per-file let the
// service worker and the options page drift apart on how a missing key or an
// undefined substitution renders.
export const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String))
