# Breakpoint

A Chrome extension that tracks reading progress on articles, estimates time
remaining, flags a break target, and lets you save/resume reading positions.

## Load it locally

1. Open `chrome://extensions`.
2. Enable "Developer mode" (top right).
3. Click "Load unpacked" and select this project folder.
4. Open a long article (e.g. on Medium) — the progress bar and pill should
   appear in the top-right of the page.

## Features (v1)

- Live reading-progress bar against the detected article content.
- Estimated time remaining (word count ÷ ~200 WPM).
- Break target: set a % in the popup; get a one-time in-page nudge when you
  cross it.
- Auto-saved scroll position with a "Resume reading?" prompt on revisit.
- Manual "Save Breakpoint" button plus a panel to jump back to saved points.
- Reading queue: add the current page from the popup, open or remove later.

All data is stored locally via `chrome.storage.local` — no accounts, no sync.
