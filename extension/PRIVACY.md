# Privacy Policy — Kaching

_Last updated: 2026-08-25_

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
| Messages that are not one of those commands, and the daily totals needed to answer them — including how a day's takings split by the currency buyers paid in | To answer a question about the totals in plain words | **Only if you set an API key.** Sent to the API service you chose in the settings — OpenAI by default, or any OpenAI-compatible service you point it at — on your own key and your own bill. With no key set, no request is ever made and such messages are ignored entirely. That service's own privacy policy governs what it receives. |
| Your API key | To make that request | Stored locally in the browser; sent only to the API service you chose |

## What it does not do

- No analytics, telemetry, tracking, or crash reporting.
- No data is sent to the developer of this extension.
- Nothing is transmitted anywhere except Google (the request you would make by
  opening the Console yourself), the Telegram bot you chose, and — only if you
  set an API key and only for messages that are not commands — the API service
  you chose.
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
daily tallies, learned rates, the payout currency and any remembered
question-and-answer pairs. Clearing the API key field and saving removes the
key.

## Your Telegram bot

Kaching sends messages through a bot you create. Telegram's own privacy policy
governs those messages once delivered. Revoke access at any time with `/revoke`
in @BotFather.

## The API service you choose

Answering in plain words is off unless you enter an API key. With one entered,
any message you send the bot that is not one of its commands — along with the
daily totals needed to answer it, and how those totals split by the currency
buyers paid in — is sent to the service named in the **API
base URL** setting, under your own account there. The default is OpenAI
(`api.openai.com`); you may point it at any service speaking the OpenAI
chat-completions API, including one on your own machine. That service's privacy
policy governs the data, not this one. Delete the key in the settings to turn
the feature off again; the bot then answers commands only.

The extension is installed with permission to reach only the default service.
Pointing it anywhere else asks Chrome for permission for that host, which you
can refuse or revoke.

**In a group, how much this is depends on Telegram settings the extension cannot
see.** Privacy mode, which Telegram enables by default, hands a bot only
commands, @mentions and replies to its own messages. But it does not apply to a
bot that has been made an administrator of the group, and it can be turned off
in @BotFather. In a group where either is true, every message in that group is
sent to the API service once you have set a key. If that is not what you want, keep
the bot out of the group's admin list, leave privacy mode on, or leave the API
key blank.

## Contact

Email: **dev@sskplay.com**
