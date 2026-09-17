# Breakpoint

A Chrome extension that tracks reading progress on articles, estimates time
remaining, and suggests smart places to pause based on the article's own
structure.

## Load it locally

1. Open `chrome://extensions`.
2. Enable "Developer mode" (top right).
3. Click "Load unpacked" and select this project folder.
4. Open a long article (e.g. on Medium) — the progress bar and pill should
   appear at the top of the page.

## Features (v1.1)

- Live reading-progress bar against the detected article content, with a
  fixed 25/50/75/100 percentage ruler for orientation.
- Estimated time remaining (word count ÷ ~200 WPM).
- Smart breakpoints: section headings in the article are used as suggested
  pause points, shown as quiet tick markers on the bar (no popups while
  you're reading).
- Auto-saved scroll position with a "Resume reading?" prompt on revisit.
- Reading queue: add the current page from the popup, open or remove later.

All data is stored locally via `chrome.storage.local` — no accounts, no sync.
