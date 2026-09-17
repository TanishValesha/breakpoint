# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Breakpoint" is a Chrome Manifest V3 extension that tracks reading progress
on articles (Medium and generic blogs), estimates time remaining, suggests
smart pause points derived from the article's own section headings, and lets
the user auto-resume reading positions plus queue articles for later. All
state is local (`chrome.storage.local`) — no backend, no accounts, no build
step.

## Development workflow

There is no build step, package manager, or test suite — it's plain
JS/HTML/CSS loaded directly by Chrome.

- **Load/reload the extension**: `chrome://extensions` → enable "Developer
  mode" → "Load unpacked" → select the project root. After editing files,
  click the extension's reload icon on that page, then refresh the test tab.
- **Syntax-check a JS file** (no linter configured): `node --check <file>`
- **Validate the manifest**: `python3 -m json.tool manifest.json`
- **Debug logging**: `content.js` logs `[Breakpoint] detected article:` to
  the page's DevTools console with the detected element, computed height,
  `scrollableDistance`, and word count — check this first when progress
  tracking misbehaves on a given site.
- No Chromium-based browser is guaranteed to be available in the dev
  environment — if one isn't installed, changes must be verified manually by
  the user in their own Chrome, following the steps in `README.md`.

## Architecture

Three content scripts are injected together (in this fixed order, per
`manifest.json`) and share state via a single `window.Breakpoint` global
object — there's no module system or bundler, so load order matters:

1. **`src/content/article-detect.js`** → `window.Breakpoint.detect`
   Finds the DOM element that bounds the actual article content, using a
   layered strategy (cheapest/most reliable first): semantic `<article>`/
   `<main>` tag → small hostname→selector override map (e.g. Substack) →
   a dependency-free, trimmed Arc90/Readability-style scorer (paragraph
   density minus link density, adjusted by class/id keyword hints) →
   `document.body` as a last-resort fallback. Also exposes word counting and
   `findHeadings()` (all `h2`/`h3` elements within the article, used as
   candidate smart-breakpoint locations).

2. **`src/content/progress-bar.js`** → `window.Breakpoint.ui`
   All visible UI (progress bar, fixed 25/50/75/100 percentage ruler, %/time
   pill, breakpoint tick markers, toasts) renders inside a single Shadow DOM
   root so nothing leaks into or is affected by the host page's CSS. Exposes
   an imperative API (`updateProgress`, `setBreakpointMarkers`,
   `showResumeToast`) — it holds no business logic itself.

3. **`src/content/content.js`**
   Orchestrates everything: scroll tracking, storage reads/writes, and
   wiring UI callbacks. Two key design points:
   - **Bounds measurement** (see `docs/` for the bug this solved): article
     bounds are measured two ways — `refreshBounds()` is cheap (re-reads the
     *already-detected* element's current layout box) and runs on every
     scroll tick, while `detectAndMeasure()` is expensive (re-runs full
     detection from `article-detect.js`) and only runs on init, `resize`, a
     debounced `MutationObserver` on `document.body` (catches SPA hydration
     growth), and a couple of fixed early timers — this matters because
     sites like Medium keep rendering content after `document_idle`, so a
     single early height snapshot goes stale and breaks the progress math.
   - **Smart breakpoints**: `computeBreakpoints()` (called from within
     `detectAndMeasure()`, so it re-runs whenever bounds are re-detected)
     turns each heading from `findHeadings()` into a percentage using the
     *same formula* as reading progress, filters to the 5–95% range, and
     drops any heading within 8 percentage points of one already kept to
     avoid a cluster of near-duplicate breakpoints. These are rendered as
     silent tick markers on the bar only (`ui.setBreakpointMarkers`) — an
     earlier version also fired a toast per breakpoint crossed, but that was
     removed after user testing found it too disruptive mid-read; don't
     reintroduce a scroll-triggered toast for these without being asked.

`src/popup/` (popup.html/js/css) is a separate, independent UI: the on/off
toggle and reading queue. It talks to `chrome.storage.local` directly and to
the active tab via the `activeTab` permission — it does not communicate with
the content scripts directly, only through shared storage.

### Storage keys (all in `chrome.storage.local`)

- `breakpoint:enabled` (bool) — global on/off, read by both the popup and
  content script, kept in sync live via `chrome.storage.onChanged`.
- `breakpoint:queue` — global array of `{ url, title, addedAt }`.
- `bp:<origin+pathname>` — per-article auto-saved resume position
  (`{ url, title, percent, scrollY, updatedAt }`); pruned periodically
  (>90 days old or beyond ~300 entries).

Smart breakpoints are computed fresh from the DOM each page load/re-detect —
they are not persisted to storage.

Storage keys intentionally strip query string/hash from the URL, so
paginated articles that vary only by `?page=` will collide — a known,
accepted trade-off for this MVP.

## Permissions

Only `storage` and `activeTab` are declared. The content script matches
broadly (`http://*/*`, `https://*/*`) rather than using `host_permissions` +
on-click injection, because the bar must appear automatically on arbitrary
article sites without the user clicking the toolbar icon — this is the one
broad-access permission Chrome surfaces at install and should not be
narrowed without changing that requirement.

## Documented issues

`docs/` contains write-ups of non-obvious bugs and their fixes (e.g.
`scroll-progress-100-percent-bug.md`) — check there before re-diagnosing a
previously-solved class of problem, particularly anything related to
progress/height measurement timing on SPA-heavy sites.
