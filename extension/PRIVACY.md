# Privacy Policy — Kaching

_Last updated: 2026-08-22_

Published at **https://apps.sskplay.com/privacy/webstore/** — that is the URL to
give the Chrome Web Store dashboard. This file is the source; keep the two in
step when either changes.

Kaching is a personal notification tool. It has no server, no account, and no
operator other than you.

## What it accesses

| Data | Why | Where it goes |
|---|---|---|
| Your Google Play Console session cookie (`SAPISID`) | To sign the request to Play's own orders endpoint, exactly as the Console page does | Never leaves your browser. It is used to compute a one-way hash sent to Google only. |
| Order records from your Play Console (order ID, product, package name, buyer country, amount, timestamp, state) | To build the notification | Sent only to the Telegram bot **you** configured |
| Your Telegram bot token and chat ID | To deliver the notification | Stored locally in the browser; sent only to `api.telegram.org` |
| Messages sent to your bot | To answer `/today`, `/week`, `/month`, `/recount` and `/adjust` | Read from `api.telegram.org` on a recurring check. Only messages from the chat you configured are acted on; anything else is discarded beyond the chat's name and ID, kept locally so **Find chat ID** still works. |

## What it does not do

- No analytics, telemetry, tracking, or crash reporting.
- No data is sent to the developer of this extension or to any third party.
- Nothing is transmitted anywhere except Google (the request you would make by
  opening the Console yourself) and the Telegram bot you chose.
- No data is sold, rented, or shared. No advertising.
- Individual order records are not retained. What is kept locally is a rolling
  list of recently seen order IDs (so the same order is not announced twice and
  so a refund can be matched to the charge it reverses), a per-day tally of
  amounts, order counts and refund counts holding roughly a year of days and the
  day that tally began, any corrections you entered with `/adjust`, the exchange
  rates read off your own settled orders, the currency you are paid in, and the
  name and ID of chats that have messaged your bot. None of it leaves
  your machine.

## Where data is stored

In `chrome.storage.local` on your own machine. Uninstalling the extension
removes it. **Reset history** in the settings clears all of it — seen orders,
daily tallies, learned rates and the payout currency.

## Your Telegram bot

Kaching sends messages through a bot you create. Telegram's own privacy policy
governs those messages once delivered. Revoke access at any time with `/revoke`
in @BotFather.

## Contact

Email: **dev@sskplay.com**
