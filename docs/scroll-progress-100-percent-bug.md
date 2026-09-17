# Bug: progress bar jumps to 100% on the first scroll (Medium)

## Symptom

On Medium articles, scrolling even a small amount immediately snapped the
progress bar and pill to 100%, instead of tracking gradually through the
article.

## Root cause

Progress is computed as:

```
scrollableDistance = articleHeight - viewportHeight
progress = (scrollY - articleTop) / scrollableDistance
```

`content.js` originally measured `articleHeight` **once**, 800ms after
`document_idle`, and only re-measured it on a `resize` event. Medium is a
heavy client-rendered SPA whose article body keeps hydrating and growing
after `document_idle` fires (images, embeds, and text can still be streaming
in). That single early snapshot likely caught the `<article>` element while
it was still short — close to or shorter than the viewport.

When `articleHeight - viewportHeight` comes out ≤ 0, the code clamps
`scrollableDistance` to a minimum of `1` (to avoid a divide-by-zero). From
that point, any real scroll delta (e.g. 50px) divided by `1` massively
overshoots `1.0` and gets clamped to 100% — on literally the first scroll
event.

In short: **the height was measured too early, before the page finished
rendering, and the resulting tiny `scrollableDistance` made the math blow up
on the very next scroll.**

Note: this diagnosis was made by reading the code's logic rather than a live
trace — no Chromium-based browser was available in the dev environment to
load the extension, and `curl` against medium.com was blocked by Cloudflare's
bot challenge, so the actual Medium DOM couldn't be inspected directly.

## Fix

In `src/content/content.js`, bounds measurement was split into two functions:

- **`refreshBounds()`** — cheap: re-reads the *already-detected* element's
  current `getBoundingClientRect()` / `offsetHeight`. Now called on **every
  scroll tick** (inside the existing `requestAnimationFrame` throttle), so if
  the article keeps growing while the user is reading, the bounds stay
  current instead of going stale.
- **`detectAndMeasure()`** — expensive: re-runs full article detection
  (`findArticleElement()`) plus a bounds refresh and word-count update. Only
  called when the DOM has plausibly changed meaningfully:
  - once at init,
  - on `resize`,
  - via a debounced `MutationObserver` watching `document.body` for
    childList/subtree changes (catches SPA hydration growth),
  - and at two extra fixed delays (1.5s and 3s after load) to catch Medium's
    late-arriving content before the user has likely started scrolling.

A `console.debug("[Breakpoint] detected article:", …)` log was also added,
printing the detected element plus its height, computed
`scrollableDistance`, and word count — useful for diagnosing similar issues
on other sites without needing to re-instrument the code.

## Why this fix addresses it

- Re-measuring on every scroll tick means even if the *first* snapshot is
  wrong, the bounds self-correct within a frame or two as the real content
  height becomes available — the bar can't get permanently stuck on a stale,
  too-small `scrollableDistance`.
- The `MutationObserver` + extra timed re-detections target the specific
  cause (SPA hydration finishing after our original one-shot measurement)
  rather than just papering over the symptom.

## Verification

Not yet confirmed against live Medium (see note above on missing browser
access in the dev environment). Next step: reload the unpacked extension in
`chrome://extensions`, open a Medium article, and confirm the bar advances
proportionally with scrolling instead of jumping to 100% immediately. If it
still misbehaves, check the DevTools console for the `[Breakpoint] detected
article:` log to see what element/height was actually measured.
