# Chrome Web Store listing

Copy for the developer dashboard. Not shipped in the extension package.

## Single purpose

Notify the user through Telegram when their own Google Play developer account
receives a new order or a refund.

## Short description (132 char max)

This is the manifest `description`, not a dashboard field — changing it means
rebuilding the package.

> New Google Play orders and refunds, pushed to Telegram. No server, no account, no SDK.

## Detailed description

Kaching watches your Google Play Console orders and sends a Telegram message
when a new order or refund appears — so you find out without opening the
Console.

It runs entirely in your browser, using the Play Console session you are already
signed in to. There is no server, no account, and nothing to install on your
phone beyond Telegram itself.

**What you get in each message**

- Product name, product ID and package
- Buyer country
- Amount charged and your estimated net — what is left after tax and Google's
  cut. Before Play settles an order that is an estimate in the buyer's currency,
  and it says so on the line; afterwards it is Play's own figure in yours. An
  optional line shows the breakdown
- Order ID
- Time in your local zone, in UTC, or both
- What the day has brought in so far, as a footer. Send the bot `/today`,
  `/week` or `/month` at any point — they sit in the bot's command menu — and it
  answers within seconds
- `/recount` works a day out again from Play and writes the result back, and
  `/adjust -6500` patches a day by hand, either direction, any day
- Anything you type that is not a command is answered as a question about the
  totals — "how did last week go, day by day" — by reading the same tally.
  Optional, off until you enter your own API key, and read-only: it cannot
  change a figure. Works with any OpenAI-compatible service — DeepSeek by
  default, or OpenAI, a gateway, or a model on your own machine

**What you can control**

- Which events to hear about — new orders, refunds, or both
- Which apps to watch, or all of them
- A minimum payout, so zero-value test orders stay quiet
- Whether each message carries the day's running total
- How often to check, and how far back each check reads
- An optional sender label, for when one Telegram chat collects alerts from
  several places

**You can see what it has been doing**

The settings page keeps a running activity log — every check, every message
sent, every failure and recovery. It stays on your machine and answers "is this
still working?" without opening a console.

**It tells you when it breaks**

A notification tool that dies quietly is worse than none — silence looks exactly
like a slow sales day. If Kaching cannot read your orders three times running,
it says so, and tells you when it recovers.

**Requirements**

- Signed in to Play Console in this browser
- A Telegram bot (create one with /newbot in @BotFather — takes a minute)
- Chrome must be running for checks to happen

Kaching is not affiliated with Google or Telegram.

## Permission justifications

| Permission | Justification |
|---|---|
| `alarms` | Schedules the periodic order check. |
| `storage` | Stores your settings and the list of order IDs already announced, so the same order is not sent twice. |
| `cookies` | Reads the `SAPISID` cookie for play.google.com to sign the request to Play's orders endpoint, which is how the Play Console authenticates its own requests. The cookie value is never transmitted; only a one-way hash of it goes to Google. |
| `declarativeNetRequest` | Sets the `Origin` header on the extension's own request to Play's orders endpoint. Google validates the request signature against this header, so it must match play.google.com. |
| Host: `play.google.com` | Reads the session cookie used to sign the request. |
| Host: `playconsolemonetization-pa.clients6.google.com` | The Play Console orders endpoint the extension reads from. |
| Host: `api.telegram.org` | Delivers the notification to the bot the user configured. |
| Host: `api.deepseek.com` | Answers questions the user types in plain words, using an API key the user supplies. No request is made unless the user has entered a key. |
| Optional host: `https://*/*` | Requested at runtime, never at install, and only when the user changes the API base URL to a different OpenAI-compatible service. Chrome prompts for the specific host at that moment. |

## Data usage disclosures

- **Does not** collect personally identifiable information beyond what the user
  enters (Telegram bot token, chat ID and an optional API key), which
  stays on the user's machine.
- **Does not** collect health, authentication, location or web history data.
- **Does not** collect anything for the developer of this extension. Nothing is
  sent to the developer or to any endpoint the developer operates.
- **Collects personal communications and financial information, for the user's
  own purposes only, and only if the user opts in by entering an API
  key.** With a key set, messages the user sends their own bot that are not
  commands, together with the daily sales totals needed to answer them, are sent
  to the OpenAI-compatible API service the user selected (`api.deepseek.com` by
  default), under the user's own account there. With no key set no such request
  is ever made. Order data is otherwise forwarded only to the
  user's own Telegram chat.
- **Not** sold. Not transferred to any third party chosen by the developer; the
  only third-party transfer is the one above, to a service the user signs up for
  and pays for themselves.
- **Not** used for purposes unrelated to the single purpose above.
- **Not** used for creditworthiness or lending.

## Privacy policy URL

The dashboard rejects submission without a **publicly reachable** URL, and the
reviewer reads it against the declared permissions — particularly `cookies`.

The store does **not** require the source to be published; review is done on the
uploaded package. The policy still needs its own public URL — a reviewer follows
it to check the `cookies` justification.

Published at **https://apps.sskplay.com/privacy/webstore/** (source:
`apps.sskplay.com` repo, `docs/privacy/webstore/index.html`). The page names the
extension and walks each permission, because what a reviewer checks is that the
policy accounts for the permissions this item declares — a shared page has to
grow a section per extension once there is more than one.

The existing https://apps.sskplay.com/privacy is not a substitute on its own: it
covers Android apps served by AdMob and mentions neither Telegram, cookies, the
Play Console, nor order data. A reviewer comparing it against the `cookies`
permission finds nothing that explains the request. That page already anticipates
this — "unless a specific app provides its own separate policy" — so a dedicated
per-extension page is the intended shape rather than an exception.

## Before publishing

- [ ] Confirm no personal developer ID, chat ID, or token remains in the
      shipped zip: `./tools/package.sh` then grep the archive.
- [ ] Deploy the `apps.sskplay.com` site so `/privacy/webstore/` is live, and
      paste that URL into the dashboard.
- [ ] Verify **dev@sskplay.com** in the dashboard, and point the support URL at
      the repository's issues.
- [ ] Take store screenshots (1280x800 or 640x400): the settings page and a
      sample Telegram notification.
