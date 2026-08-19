# Store assets

Not shipped in the extension package — `tools/package.sh` only zips `extension/`.

```
screenshots/hero.png             1280×800   listing screenshot
screenshots/filters.png          1280×800
screenshots/alerts.png           1280×800
screenshots/settings.png         1280×800
screenshots/promo-440x280.png    440×280    small promo tile (optional)
```

The Chrome Web Store accepts screenshots at exactly **1280×800** or **640×400**.
These are rendered at 2× and downscaled, so text stays crisp.

## Regenerating

`src/` holds the tile sources. They are rendered by a headless browser rather
than drawn by hand, so the settings shot is the real options page and cannot
drift from what ships.

The four tiles are self-contained — serve the repo root and open
`/store/src/<tile>.html` at 1280×800 with `deviceScaleFactor: 2`, then downscale
to 1280×800.

`settings-raw.png` is the embedded screenshot of the options page. To retake it,
copy `extension/` into a scratch dir, drop `stub.js` in beside `options.html`,
and **replace** the page's script tag with it:

```html
<script type="module" src="stub.js"></script>
```

`stub.js` stands in for the extension host — it feeds `options.js` the real
`_locales/en/messages.json` and sample settings — and imports `options.js`
itself at the end. Leaving both as sibling `<script type="module">` tags does
not work: they are separate module graphs, so `stub.js`'s top-level `await`
does not hold `options.js` back, and it renders every label as an empty string
whenever the catalogue fetch loses the race. Capture at 660×900,
`deviceScaleFactor: 2`.

ES modules do not load over `file://`, so a static server is required; make sure
it serves `.css` as `text/css` or the tiles render unstyled.

Sample values only — no real order IDs, tokens, chat IDs, or developer IDs
appear in any asset.
