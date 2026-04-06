# Contributing to Site Inspector

Thanks for considering a contribution! This is a small, single-purpose Chrome extension and contributions of any size are welcome.

## Ways to contribute

- **Bug reports** — open an issue describing what you tried, what happened, and what you expected. Screenshots help.
- **Feature requests** — open an issue and describe the use case. Note: features that require paid APIs will not be accepted (see scope below).
- **Pull requests** — small, focused changes are easier to review than large ones. If you're planning a substantial change, open an issue first to discuss the approach.
- **New tech detection signatures** — if you spot a framework/CMS/analytics tool that the `detectTech()` function in `popup.js` misses, PRs adding signatures are very welcome.

## Project scope

Site Inspector is intentionally narrow:

- It must work with **only free, no-key APIs**. PRs that add paid services or require API key signup will be declined.
- It must remain a **zero-dependency, zero-build** extension. No npm, no bundlers, no transpilers — four files, drop into Chrome.
- It must respect **user privacy**. No telemetry, no analytics, no remote logging.

## Local development

```bash
git clone https://github.com/rockbye-kunal/site-inspector.git
cd site-inspector
```

Then load it in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select the `site-inspector` folder
4. Make changes to the files
5. Click **Reload** on the extension card in `chrome://extensions` to see your changes
6. Right-click the extension popup → **Inspect** to open DevTools and see console errors

## Code style

- Vanilla JavaScript, no framework
- 2-space indentation
- Single quotes for strings
- Semicolons
- Keep functions small and named clearly
- Match the existing patterns in `popup.js` (state object, fetchers, parsers, renderers)

## Submitting a pull request

1. Fork the repo and create a topic branch off `main`
2. Make your changes
3. Test in Chrome — load unpacked, run through every tab, check the DevTools console for errors
4. Open a PR with a clear description of what changed and why
5. Be patient — this is a side project, reviews may take a while

## License

By contributing, you agree that your contributions will be licensed under the MIT License (see `LICENSE`).
