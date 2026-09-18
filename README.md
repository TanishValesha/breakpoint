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
- Reading queue: add the current page from the popup, open or remove later.

All data is stored locally via `chrome.storage.local` — no accounts, no sync.
