# Breakpoint

A Chrome extension that tracks reading progress on articles and estimates
time remaining, so you know when a good moment to take a break is.

## Load it locally

1. Open `chrome://extensions`.
2. Enable "Developer mode" (top right).
3. Click "Load unpacked" and select this project folder.
4. Open a long article (e.g. on Medium) — the progress bar and pill should
   appear at the top of the page.

## Features (v1.1)

- Live reading-progress bar against the detected article content.
- Estimated time remaining (word count ÷ ~200 WPM).
- Reading timer: the pill shows active time spent on the *current* article;
  the popup separately shows your all-time total across every article,
  which keeps growing until you reset it — with enable/pause/resume/reset
  controls there.
- Break reminder: a toast every N minutes of active reading on one article
  (once you pause scrolling, so it never interrupts mid-read) — pick the
  interval from six presets (5/10/15/20/25/30 min) in the popup.
- Auto-saved scroll position with a "Resume reading?" prompt on revisit.
- Breakpoints panel: open the list icon in the pill to see every section
  heading in the article — tap a heading to jump to it, or tap its
  bookmark icon to save it as one of your own breakpoints for next time.
  Scroll past one you've saved and it celebrates with a confetti cannon
  from each side of the screen plus a toast suggesting a break.
- Reading queue: add the current page from the popup, open or remove later.

All data is stored locally via `chrome.storage.local` — no accounts, no sync.

The confetti effect uses [canvas-confetti](https://github.com/catdad/canvas-confetti),
vendored locally in `src/content/vendor/` — the only external dependency in
this project.

## Logo

The icon is a bookmark with a progress stripe across it — the two things
this extension actually does (mark a breakpoint, track reading progress) in
one mark. Source is `icons/logo.svg`; `icons/icon16.png`, `icon48.png`, and
`icon128.png` are rendered from it (`convert -background none icons/logo.svg
-resize <N>x<N> icons/icon<N>.png`). The popup's small header mark
(`src/popup/popup.html`) is the same shape, redrawn inline.

The fill is a flat blue, not a gradient, deliberately: this environment has
no proper SVG renderer (`rsvg-convert`/`inkscape` aren't installed), so
`convert` falls back to ImageMagick's bundled minimal SVG parser, which
doesn't reliably resolve `<linearGradient>` references — it silently
rendered the background black instead of erroring. If you add gradients
back to `logo.svg` later, re-render all three PNGs and actually open each
one to confirm the fill resolved, rather than trusting a clean exit code.
