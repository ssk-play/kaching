#!/usr/bin/env bash
# Builds the zip uploaded to the Chrome Web Store.
#
# Only what the extension needs at runtime goes in — docs, the icon source, and
# Chrome's generated ruleset cache would otherwise ride along and show up in
# review as unexplained files.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ext="$root/extension"
version="$(node -p "require('$ext/manifest.json').version")"
out="$root/dist/kaching-$version.zip"

mkdir -p "$root/dist"
rm -f "$out"

cd "$ext"
zip -q -r "$out" \
  manifest.json rules.json \
  background.js playconsole.js settings.js filters.js format.js fx.js health.js i18n.js ledger.js llm.js log.js telegram.js totals.js \
  options.html options.js \
  _locales \
  icons \
  -x 'icons/*.svg' -x '_metadata/*' -x '*/.*' -x '.*'

# The file list above is hand-maintained, so nothing stops a newly imported
# module from being left out. Unpacked loading would still work and the tests
# import from extension/ directly, so the gap would only surface as a failed
# service-worker registration after the store round-trip.
node - "$out" <<'CHECK'
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')

const zip = process.argv[2]
const shipped = new Set(execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n'))

const missing = []
const want = (path, why) => {
  if (!shipped.has(path)) missing.push(`${path} (${why})`)
}

// Every relative import in a shipped module, and every local asset the options
// page and the manifest reference.
for (const file of [...shipped].filter((f) => f.endsWith('.js'))) {
  const text = fs.readFileSync(file, 'utf8')
  // Both quote styles and dynamic import: matching only one form made the
  // check pass on exactly the module it was meant to catch.
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]\.\/([^'"]+)['"]/g)) {
    want(m[1], `imported by ${file}`)
  }
}
for (const m of fs.readFileSync('options.html', 'utf8').matchAll(/(?:src|href)="(?!https?:)([^"]+)"/g)) {
  want(m[1], 'referenced by options.html')
}
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'))
want(manifest.background.service_worker, 'manifest service_worker')
want(manifest.options_ui.page, 'manifest options_ui')
for (const r of manifest.declarative_net_request.rule_resources) want(r.path, 'manifest ruleset')
for (const p of Object.values(manifest.icons)) want(p, 'manifest icon')
for (const locale of ['en', 'ko']) want(`_locales/${locale}/messages.json`, 'locale')

if (missing.length) {
  console.error('package incomplete:\n  ' + missing.join('\n  '))
  process.exit(1)
}
CHECK

echo "$out"
unzip -Z1 "$out" | sed 's/^/  /'
