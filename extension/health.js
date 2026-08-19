// When the extension is allowed to say it is broken.
//
// This has been wrong in both directions. Never clearing the cooldown muted the
// second outage of the day; clearing it on every success made the cooldown
// unreachable, so a flapping session produced an alert and a recovery notice
// every few polls. The rule that survives both: alert once a run of failures
// crosses the threshold, and never more often than the cooldown — measured from
// the last alert that actually arrived, not from the last attempt.

export const FAILS_BEFORE_ALERT = 3
export const ALERT_COOLDOWN_MS = 60 * 60 * 1000

export function shouldAlert(fails, lastAlertAt, now = Date.now()) {
  return fails >= FAILS_BEFORE_ALERT && now - lastAlertAt > ALERT_COOLDOWN_MS
}
