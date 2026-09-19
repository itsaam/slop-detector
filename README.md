# Slop Detector

![Manifest V3](https://img.shields.io/badge/Manifest-V3-30363d?style=flat)
![Chrome 120+](https://img.shields.io/badge/Chrome-120%2B-30363d?style=flat)

A Chrome extension that flags low-substance engagement bait while you scroll X. Uses Jev through your own TypeSafe or OpenRouter account.

Posts receive a discreet **Not slop** score or a red **SLOP** stamp. Optional blur can be revealed at any time. The threshold and definition are configurable in the popup.

## Install

1. Download the ZIP from [Releases](https://github.com/itsaam/slop-detector/releases/latest) and extract it.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked**, then select the folder containing `manifest.json`.
4. Open the popup, select TypeSafe or OpenRouter, and enter your API key.
5. Read the data disclosure, enable remote analysis, save, and reload X.

Keep the extracted folder in place. To update, replace its contents, reload the extension, and refresh X. The Chrome Web Store listing is not yet published.

## What it does

- Runs only on `x.com` and `twitter.com`.
- Analyzes posts as they approach the viewport; caches results to avoid repeat requests.
- Keeps blur in sync when X replaces media or restores the timeline.
- Marks X's own **Made with AI** disclosure as SLOP locally, without an API call. Simply mentioning AI does not trigger this rule.
- Offers an optional **Insufficient context** mode for short media captions and truncated text. Disabled by default.

Jev evaluates text, not images or video. Scores are estimates under your chosen definition, not proof that a person used AI. False positives and false negatives are possible. Posts with no readable text are skipped unless a supported platform AI label is present or the context option is enabled.

## Data and cost

Remote analysis is off until you explicitly enable it. The selected provider receives the post text, quoted text when present, limited context flags, and your definition. OpenRouter routes Jev requests to TypeSafe. API usage is billed by your provider; the extension does not include credits.

Keys, preferences, and a bounded result cache stay in `chrome.storage.local`. Keys are sent only to their matching provider. No analytics, ads, or developer-operated proxy. The **Test** button sends a fixed example and may incur a charge.

See [PRIVACY](PRIVACY) for the full data handling details. Do not enable remote analysis on content you do not want sent to the selected provider, including protected posts visible to your account.

## Development

Plain JavaScript, HTML, and CSS. No runtime dependencies or build step. Node.js 22 or later is used for checks and packaging.

Checks run locally; this repository does not use GitHub Actions.

```sh
npm test
npm run package
```

The ZIP is written to `dist/` with `manifest.json` at its root. It contains only extension runtime files, not tests or documentation.

Packaging checks verify reproducibility, the archive allowlist, matching source files, version consistency, and icon dimensions. Store listing text and demonstration images are kept separately in `store/` and never shipped in the extension.

Browser regressions are in `tests/browser/`. Serve this directory with any local HTTP server, open the fixture, and run its checks. Provider responses are simulated; no key or credits are needed.

Bug reports: [Issues](https://github.com/itsaam/slop-detector/issues). Please omit API keys, private posts, and other sensitive content.

Changes are proposed through pull requests. Run the checks and relevant browser regressions before requesting review; do not include real credentials in fixtures or screenshots.
