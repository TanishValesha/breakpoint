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
   `document.body` as a last-resort fallback. Also exposes word counting and
   `findHeadings()` (every `h2`/`h3` in the article, unfiltered — used by
   the user-assigned breakpoints panel; see below for why "unfiltered" is
   fine here unlike the earlier auto-suggested version).

2. **`src/content/progress-bar.js`** → `window.Breakpoint.ui`
   All visible UI (progress bar, %/time pill with a reading-timer readout
   and a breakpoints-panel toggle, the resume toast) renders inside a
   single Shadow DOM root so nothing leaks into or is affected by the host
   page's CSS. Exposes an imperative API (`updateProgress`, `updateTimer`,
   `renderHeadings`, `showResumeToast`) — it holds no business logic itself.

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
   unnecessary. Don't reintroduce that specific shape — an *always-visible,
   extension-decided* set of pause points — without being explicitly asked.
   The reason that one failed wasn't "headings are a bad basis for
   breakpoints" — it was that the extension auto-picked and constantly
   surfaced *every* heading with no user choice involved. The break-nudge
   toast below is a deliberately different trigger (rare, time-based) and
   the user explicitly asked for it as a toast. The user-assigned
   breakpoints panel (also below) deliberately revives headings as the
   basis, but inverted: it's opt-in (closed by default, the user opens it),
   and the user picks which headings matter, rather than the extension
   deciding for them. The throughline lesson is about *who decides and how
   often it's shown*, not about avoiding toasts or headings altogether.

   **User-assigned breakpoints panel**: a list button in the pill
   (`.pill-headings-toggle`) opens `.headings-panel`, listing every heading
   from `findHeadings()` via `computeHeadings()` (recomputed on every
   `detectAndMeasure()`, so it stays current through SPA hydration). Each
   row has two independent controls, deliberately not one dual-purpose tap:
   clicking the label always jumps there (`jumpToHeading()`, preferring the
   live element's current position over its last-computed percent, since
   the page may have reflowed since detection); a separate bookmark icon
   toggles whether that heading is saved (`toggleMarkHeading()`). Marking is
   keyed by the heading's **text label**, not a stored scroll position or
   DOM reference — simple, and good enough across visits: if the site's
   headings haven't changed, the same labels reappear already marked.
   Persisted per article to `bpMarks:<origin+pathname>` (an array of
   labels), loaded in `enterPage()` via `loadMarkedHeadings()`.

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

   **Reading timer — two deliberately separate counters**:
   - `state.sessionElapsedMs` tracks active time on *this article view only*
     and resets on every `enterPage()`. This is what the pill displays live
     (`ui.updateTimer`) and what the break nudge reads — a global lifetime
     number can't drive the nudge, since once it ever crosses the threshold
     it would stay crossed forever and fire on every single article.
   - The lifetime total lives *only* in `chrome.storage.local`
     (`breakpoint:timerTotalMs`) — no tab keeps a local copy of "the total"
     in memory, specifically to avoid one tab's stale view of it clobbering
     another's. Each tab instead tracks `state.unflushedDeltaMs` — the time
     *this tab* owes the shared total since its last flush — and
     `flushGlobalTimer()` adds that on top of a value it re-reads from
     storage at flush time (`current + owed`), not a cached baseline. That
     add-on-top-of-a-fresh-read is what lets two tabs reading at different
     times actually sum instead of one overwriting the other. It's still not
     a fully coordinated single clock (a background service worker would be
     needed for that, which this project has deliberately avoided), but it
     no longer loses a tab's contribution just because another tab flushed
     — only two tabs flushing at the *exact* same instant can still race.

   `shouldTimerRun()` requires the tab visible, the extension and timer both
   enabled, on an article page, and not paused (`breakpoint:timerPaused`,
   global/persisted — pausing from the popup affects every tab, and
   deliberately survives article navigation rather than auto-clearing).
   `refreshTimerRunState()` starts/stops the running segment; on every stop
   transition it folds the segment into both `sessionElapsedMs` and
   `unflushedDeltaMs` and calls `flushGlobalTimer()`. A periodic checkpoint
   also runs every ~3s while continuously reading, plus one on `pagehide`,
   so a crash doesn't lose a long uninterrupted session. An explicit reset
   from the popup (`breakpoint:timerTotalMs` set to exactly `0`) is the one
   case where `chrome.storage.onChanged` also clears `unflushedDeltaMs` —
   any other change to that key (another tab's own flush) is left alone.

   **Break-reminder nudge — repeats on an interval**: `maybeShowBreakNudge()`
   runs from the same 1-second tick as the timer display and fires
   `ui.showBreakNudgeToast()` (a toast with a pulsing glow animation,
   `prefers-reduced-motion`-aware) every time `sessionElapsedMs` crosses
   another multiple of `state.nudgeThresholdMs` — a 15-min interval nudges
   at 15, 30, 45 min, and so on, not just once. `state.nudgeIntervalsFired`
   tracks how many boundaries have already fired
   (`Math.floor(sessionElapsed / nudgeThresholdMs)` vs. that counter) so
   each boundary still only nudges once, and it resets to 0 in `enterPage()`
   alongside `sessionElapsedMs`. Each nudge additionally requires
   `state.lastScrollAt` (updated on every scroll event) to be more than
   `SCROLL_IDLE_MS` (2.5s) in the past — i.e. it waits for a natural pause
   rather than interrupting mid-scroll; if you're actively scrolling right
   when a boundary is crossed, it simply nudges at the next idle moment
   instead of skipping that interval. The interval is user-configurable
   from the popup as one of six presets (5/10/15/20/25/30 min, stored in
   `breakpoint:nudgeThresholdMs`; `DEFAULT_NUDGE_THRESHOLD_MS` is the 15-min
   fallback) — presets rather than a free-text input, deliberately: this
   project already tried a free numeric input for a related setting (the old
   "Break target %" field) and it was fully removed later; every control
   that has stuck since has been a discrete choice (toggle or preset). Gated
   by its own `breakpoint:nudgeEnabled` setting, independent of the timer's
   on/off toggle.

`src/popup/` (popup.html/js/css) is a separate, independent UI: the on/off
toggle, the reading queue, and the timer's enable/pause/resume/reset
controls. All of it — including the timer, now that it's global — is
plain `chrome.storage.local` reads/writes, the same pattern as every other
setting. (An earlier version of the timer was per-tab, in-memory-only state,
which needed `chrome.tabs.sendMessage`/`chrome.runtime.onMessage` for the
popup to control it — that messaging path no longer exists now that the
timer lives in storage; don't reintroduce it unless a future per-tab-only
control genuinely needs it again.)

### Storage keys (all in `chrome.storage.local`)

- `breakpoint:enabled` (bool) — global on/off, read by both the popup and
  content script, kept in sync live via `chrome.storage.onChanged`.
- `breakpoint:timerEnabled` / `breakpoint:nudgeEnabled` (bool) — global,
  independent on/off switches for the reading-timer readout and the
  break-reminder toast, respectively.
- `breakpoint:nudgeThresholdMs` (number) — the break-reminder repeat
  interval, set via one of six presets (5/10/15/20/25/30 min) in the popup.
- `breakpoint:timerTotalMs` (number) — the lifetime reading-timer total;
  grows forever until reset from the popup.
- `breakpoint:timerPaused` (bool) — global pause for the lifetime timer.
- `breakpoint:queue` — global array of `{ url, title, addedAt }`.
- `bp:<origin+pathname>` — per-article auto-saved resume position
  (`{ url, title, percent, scrollY, updatedAt }`); pruned periodically
  (>90 days old or beyond ~300 entries).
- `bpMarks:<origin+pathname>` — per-article array of heading labels the user
  marked in the breakpoints panel. Not pruned (small, bounded by however
  many headings one article has).

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
