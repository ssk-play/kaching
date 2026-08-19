// A short activity log, so "is it working?" has an answer that does not require
// reading a service-worker console.
//
// Entries store an i18n key and its arguments rather than a rendered sentence:
// a log written in English and read after switching to Korean would otherwise
// stay frozen in the language it happened in.

export const MAX_ENTRIES = 200

// Appends are read-modify-write, and a poll can emit several in quick
// succession, so they are serialised through one chain per worker instance.
let queue = Promise.resolve()

export const read = async () => (await chrome.storage.local.get({ log: [] })).log

export function trim(entries, max = MAX_ENTRIES) {
  return entries.slice(-max)
}

function append(entry) {
  queue = queue.then(async () => {
    const { log } = await chrome.storage.local.get({ log: [] })
    await chrome.storage.local.set({ log: trim([...log, entry]) })
  })
  return queue
}

export const record = (level, key, ...args) =>
  append({ at: Date.now(), level, key, args: args.map(String) })

// For states a poll re-enters every cycle — "not configured" would otherwise
// fill the log with the same line over and over.
export function recordOnce(level, key, ...args) {
  queue = queue.then(async () => {
    const { log } = await chrome.storage.local.get({ log: [] })
    if (log.at(-1)?.key === key) return
    await chrome.storage.local.set({
      log: trim([...log, { at: Date.now(), level, key, args: args.map(String) }]),
    })
  })
  return queue
}

export const clear = () => chrome.storage.local.set({ log: [] })
