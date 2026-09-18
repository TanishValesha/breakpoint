# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Breakpoint" is a Chrome Manifest V3 extension that tracks reading progress
on articles (Medium and generic blogs), estimates time remaining, and lets
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
   `document.body` as a last-resort fallback. Also exposes word counting.

2. **`src/content/progress-bar.js`** → `window.Breakpoint.ui`
   All visible UI (progress bar, %/time pill with a reading-timer readout,
   the resume toast) renders inside a single Shadow DOM root so nothing
   leaks into or is affected by the host page's CSS. Exposes an imperative
   API (`updateProgress`, `updateTimer`, `showResumeToast`) — it holds no
   business logic itself.

3. **`src/content/content.js`**
   Orchestrates everything: scroll tracking, storage reads/writes, and
   wiring UI callbacks. Key design point (see `docs/` for the bug this
   solved): article bounds are measured two ways — `refreshBounds()` is
   cheap (re-reads the *already-detected* element's current layout box) and
   runs on every scroll tick, while `detectAndMeasure()` is expensive
   (re-runs full detection from `article-detect.js`) and only runs on init,
   `resize`, a debounced `MutationObserver` on `document.body` (catches SPA
   hydration growth), and a couple of fixed early timers — this matters
   because sites like Medium keep rendering content after `document_idle`,
   so a single early height snapshot goes stale and breaks the progress
   math.

   A structural "smart breakpoints" feature (heading-derived suggested pause
   points, shown as a toast, then a bar ruler, then bar tick markers) was
   built and then fully removed after user testing across several
   iterations found every visible form of it either disruptive or
   unnecessary. Don't reintroduce any of it — toast, ruler, or markers —
   without being explicitly asked.

   The widget is deliberately hidden on a site's own homepage/listing page
   (`isHomePage()`: pathname is `/` or an equivalent `index.html`/
   `index.php`), since there's no article to track there. This can't be a
   one-time check at content-script load: Medium (and SPAs generally) never
   reload the document on internal navigation, so clicking from the
   homepage into an article doesn't re-run the content script. `enterPage()`
   holds all the per-page setup (article detection, resume check, showing/
   hiding the UI) and re-runs on every navigation via `watchForUrlChanges()`,
   which polls `location.href` — a content script runs in an isolated JS
   world, so it cannot intercept the page's own `history.pushState` calls to
   detect navigation via an event instead. `state.onArticlePage` gates
   `onScroll`/resize/the growth-observer so they're inert while sitting on a
   non-article page between navigations.

   **Reading timer**: tracks accumulated *active* reading time for the
   current article view — `shouldTimerRun()` requires the tab visible, the
   extension and timer both enabled, on an article page, and not manually
   paused, and `refreshTimerRunState()` starts/stops the accumulator
   whenever any of those inputs change (settings change, `visibilitychange`,
   navigation). It resets to zero on every `enterPage()` — each article view
   is its own session, nothing is persisted to storage. A `setInterval`
   ticks `ui.updateTimer()` every second while on an article page.

`src/popup/` (popup.html/js/css) is a separate, independent UI: the on/off
toggle, the reading queue, and the timer's pause/resume/reset controls. It
talks to `chrome.storage.local` directly for settings/queue, but the timer
controls need to act on *this specific tab's* live, in-memory state, which
storage can't scope to one tab — so the popup instead messages the active
tab's content script directly via `chrome.tabs.sendMessage`/
`chrome.runtime.onMessage` (`timer:getState` / `timer:pause` / `timer:resume`
/ `timer:reset`), the first and only place this codebase does popup↔content-
script messaging rather than going through shared storage. No extra
manifest permission was needed — `activeTab` already covers it.

### Storage keys (all in `chrome.storage.local`)

- `breakpoint:enabled` (bool) — global on/off, read by both the popup and
  content script, kept in sync live via `chrome.storage.onChanged`.
- `breakpoint:queue` — global array of `{ url, title, addedAt }`.
- `bp:<origin+pathname>` — per-article auto-saved resume position
  (`{ url, title, percent, scrollY, updatedAt }`); pruned periodically
  (>90 days old or beyond ~300 entries).

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
