// Orchestrates article detection, scroll tracking, storage, and the injected UI.
(function () {
  const WPM = 200;
  const SAVE_DEBOUNCE_MS = 500;
  const MAX_RESUME_ENTRIES = 300;
  const MAX_RESUME_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  const BREAK_NUDGE_THRESHOLD_MS = 15 * 60 * 1000;
  const SCROLL_IDLE_MS = 2500;

  const { findArticleElement, getWordCount } = window.Breakpoint.detect;
  const ui = window.Breakpoint.ui;

  function pageKey() {
    return location.origin + location.pathname;
  }
  function resumeStorageKey() {
    return "bp:" + pageKey();
  }

  // Skip the site's own homepage/index — there's no article to track there,
  // and the widget would just be clutter on a listing page.
  function isHomePage() {
    const path = location.pathname.replace(/\/index\.(html?|php)$/i, "/");
    return path === "/" || path === "";
  }

  const state = {
    enabled: true,
    onArticlePage: false,
    articleEl: null,
    articleTop: 0,
    scrollableDistance: 1,
    wordCount: 0,
    saveTimer: null,
    tickScheduled: false,
    pendingSave: null,
    growthTimer: null,
    timerEnabled: true,
    timerStartedAt: null,
    timerManuallyPaused: false,
    // This tab's reading time not yet folded into the shared global total in
    // storage. Flushing adds this on top of whatever the total currently is
    // (read fresh at flush time), rather than overwriting it with a locally
    // cached baseline — that's what lets multiple tabs' contributions sum
    // instead of the last tab to flush clobbering the others.
    unflushedDeltaMs: 0,
    timerFlushTicks: 0,
    // Per-article-view counter — shown live in the pill, and also what the
    // break nudge reads. Deliberately separate from the global lifetime
    // total (which only lives in storage): resets on every enterPage(), so
    // it always reflects "how long on *this* article", not the all-time sum.
    sessionElapsedMs: 0,
    nudgeEnabled: true,
    lastScrollAt: 0,
    breakNudgeShown: false,
  };

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }
  function storageSet(items) {
    return new Promise((resolve) => chrome.storage.local.set(items, resolve));
  }

  // Cheap: re-reads the cached element's current layout box. Safe to call every
  // scroll tick, and picks up height changes from images/content still loading in.
  function refreshBounds() {
    if (!state.articleEl || !state.articleEl.isConnected) {
      detectAndMeasure();
      return;
    }
    const rect = state.articleEl.getBoundingClientRect();
    state.articleTop = rect.top + window.scrollY;
    const articleHeight = state.articleEl.offsetHeight;
    state.scrollableDistance = Math.max(articleHeight - window.innerHeight, 1);
  }

  // Expensive: re-runs article detection from scratch. Only call on init,
  // resize, or when the page's DOM has meaningfully changed (SPA hydration).
  function detectAndMeasure() {
    state.articleEl = findArticleElement();
    refreshBounds();
    state.wordCount = getWordCount(state.articleEl);
    console.debug("[Breakpoint] detected article:", state.articleEl, {
      height: state.articleEl.offsetHeight,
      scrollableDistance: state.scrollableDistance,
      wordCount: state.wordCount,
    });
  }

  // Sites like Medium hydrate/lazy-render article content client-side, so the
  // element we picked at init can still be growing after our first measurement.
  // Watch for DOM growth and re-detect (debounced) so bounds don't stay stale.
  function watchForContentGrowth() {
    const observer = new MutationObserver(() => {
      if (!state.onArticlePage) return;
      if (state.growthTimer) clearTimeout(state.growthTimer);
      state.growthTimer = setTimeout(detectAndMeasure, 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function getProgress() {
    const raw = (window.scrollY - state.articleTop) / state.scrollableDistance;
    return Math.min(Math.max(raw, 0), 1);
  }

  // Captures the page identity (key/url/title) at schedule time, not flush
  // time — on an SPA the URL can change before the debounce fires, and we
  // don't want a stale save landing under the *new* page's storage key.
  function scheduleSave(percent, scrollY) {
    state.pendingSave = {
      key: resumeStorageKey(),
      url: location.href,
      title: document.title,
      percent,
      scrollY,
      updatedAt: Date.now(),
    };
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    if (!state.pendingSave) return;
    const { key, url, title, percent, scrollY, updatedAt } = state.pendingSave;
    storageSet({ [key]: { url, title, percent: percent * 100, scrollY, updatedAt } });
    state.pendingSave = null;
    maybePruneResumeEntries();
  }

  async function maybePruneResumeEntries() {
    if (Math.random() > 0.05) return;
    const all = await storageGet(null);
    const resumeKeys = Object.keys(all).filter((k) => k.startsWith("bp:"));
    if (resumeKeys.length <= MAX_RESUME_ENTRIES) {
      const now = Date.now();
      const stale = resumeKeys.filter(
        (k) => now - (all[k].updatedAt || 0) > MAX_RESUME_AGE_MS
      );
      if (stale.length) chrome.storage.local.remove(stale);
      return;
    }
    const sorted = resumeKeys.sort(
      (a, b) => (all[a].updatedAt || 0) - (all[b].updatedAt || 0)
    );
    const toRemove = sorted.slice(0, resumeKeys.length - MAX_RESUME_ENTRIES);
    if (toRemove.length) chrome.storage.local.remove(toRemove);
  }

  function onScroll() {
    state.lastScrollAt = Date.now();
    if (state.tickScheduled) return;
    state.tickScheduled = true;
    requestAnimationFrame(() => {
      state.tickScheduled = false;
      if (!state.enabled || !state.onArticlePage) return;

      refreshBounds();
      const progress = getProgress();
      const wordsRemaining = state.wordCount * (1 - progress);
      const minutesRemaining = state.wordCount > 0 ? wordsRemaining / WPM : null;

      ui.updateProgress(progress * 100, minutesRemaining);
      scheduleSave(progress, window.scrollY);
    });
  }

  async function checkResumeOnLoad() {
    const data = await storageGet(resumeStorageKey());
    const entry = data[resumeStorageKey()];
    if (!entry) return;
    if (entry.percent <= 2 || entry.percent >= 97) return;
    ui.showResumeToast(entry.percent, () => {
      const target = state.articleTop + (entry.percent / 100) * state.scrollableDistance;
      window.scrollTo({ top: target, behavior: "smooth" });
    });
  }

  async function loadSettings() {
    const data = await storageGet([
      "breakpoint:enabled",
      "breakpoint:timerEnabled",
      "breakpoint:nudgeEnabled",
      "breakpoint:timerPaused",
    ]);
    state.enabled = data["breakpoint:enabled"] !== false;
    state.timerEnabled = data["breakpoint:timerEnabled"] !== false;
    state.nudgeEnabled = data["breakpoint:nudgeEnabled"] !== false;
    state.timerManuallyPaused = !!data["breakpoint:timerPaused"];
  }

  function watchSettingsChanges() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes["breakpoint:enabled"]) {
        state.enabled = changes["breakpoint:enabled"].newValue !== false;
        ui.setVisible(state.enabled && state.onArticlePage);
        refreshTimerRunState();
      }
      if (changes["breakpoint:timerEnabled"]) {
        state.timerEnabled = changes["breakpoint:timerEnabled"].newValue !== false;
        refreshTimerRunState();
      }
      if (changes["breakpoint:nudgeEnabled"]) {
        state.nudgeEnabled = changes["breakpoint:nudgeEnabled"].newValue !== false;
      }
      if (changes["breakpoint:timerPaused"]) {
        state.timerManuallyPaused = !!changes["breakpoint:timerPaused"].newValue;
        refreshTimerRunState();
      }
      if (changes["breakpoint:timerTotalMs"]) {
        // Only an explicit reset (value dropped to exactly 0, from the
        // popup) should also discard this tab's own not-yet-flushed time.
        // A normal incremental update from another tab must NOT clear it —
        // this tab's contribution still needs to sum on top independently.
        if (changes["breakpoint:timerTotalMs"].newValue === 0) {
          state.unflushedDeltaMs = 0;
          if (state.timerStartedAt) {
            const now = Date.now();
            state.sessionElapsedMs += now - state.timerStartedAt;
            state.timerStartedAt = now;
          }
        }
      }
    });
  }

  // The reading timer only counts time that's actually "active": the tab
  // visible, the extension on, the timer feature on, on an article page, and
  // not manually paused from the popup. This recomputes whether it should be
  // running right now and starts/stops the accumulator accordingly.
  function shouldTimerRun() {
    return (
      state.enabled &&
      state.timerEnabled &&
      state.onArticlePage &&
      !state.timerManuallyPaused &&
      document.visibilityState === "visible"
    );
  }

  function refreshTimerRunState() {
    const shouldRun = shouldTimerRun();
    if (shouldRun && !state.timerStartedAt) {
      state.timerStartedAt = Date.now();
    } else if (!shouldRun && state.timerStartedAt) {
      const delta = Date.now() - state.timerStartedAt;
      state.unflushedDeltaMs += delta;
      state.sessionElapsedMs += delta;
      state.timerStartedAt = null;
      flushGlobalTimer();
    }
  }

  function getCurrentSessionElapsedMs() {
    if (!state.timerStartedAt) return state.sessionElapsedMs;
    return state.sessionElapsedMs + (Date.now() - state.timerStartedAt);
  }

  // Adds this tab's not-yet-saved reading time on top of whatever the
  // shared global total currently is (read fresh here, not from a locally
  // cached copy), so two tabs reading at different times sum correctly
  // instead of whichever flushes last overwriting the other's contribution.
  async function flushGlobalTimer() {
    if (state.timerStartedAt) {
      const now = Date.now();
      const delta = now - state.timerStartedAt;
      state.unflushedDeltaMs += delta;
      state.sessionElapsedMs += delta;
      state.timerStartedAt = now;
    }
    const owed = state.unflushedDeltaMs;
    if (owed <= 0) return;
    state.unflushedDeltaMs = 0;
    const data = await storageGet("breakpoint:timerTotalMs");
    const current = data["breakpoint:timerTotalMs"] || 0;
    await storageSet({ "breakpoint:timerTotalMs": current + owed });
  }

  // Fires once per article view: only once real reading time has piled up
  // on *this* view AND the reader isn't actively mid-scroll, so it lands in
  // a natural lull rather than interrupting. Deliberately uses the
  // per-session counter, not the lifetime total — otherwise, once your
  // lifetime total ever crosses the threshold, this would fire on every
  // single article you open forever. See CLAUDE.md for why this is a toast
  // despite the earlier heading-crossing nudge being removed — the trigger
  // here is rare (once, time-based) rather than constant.
  function maybeShowBreakNudge() {
    if (state.breakNudgeShown) return;
    if (!state.enabled || !state.timerEnabled || !state.nudgeEnabled) return;
    const sessionElapsed = getCurrentSessionElapsedMs();
    if (sessionElapsed < BREAK_NUDGE_THRESHOLD_MS) return;
    if (Date.now() - state.lastScrollAt < SCROLL_IDLE_MS) return;
    state.breakNudgeShown = true;
    ui.showBreakNudgeToast(Math.round(sessionElapsed / 60000));
  }

  // Runs whenever we land on a page — both on the real initial load and on
  // every client-side navigation an SPA like Medium does afterwards, since
  // those never reload the document (see watchForUrlChanges).
  function enterPage() {
    if (isHomePage()) {
      state.onArticlePage = false;
      ui.setVisible(false);
      refreshTimerRunState();
      return;
    }
    state.onArticlePage = true;
    ui.setVisible(state.enabled);
    detectAndMeasure();
    onScroll();
    // Medium-style SPAs keep hydrating content after navigation; re-detect a
    // couple more times before the user is likely to have scrolled yet.
    [1500, 3000].forEach((delay) =>
      setTimeout(() => {
        if (state.onArticlePage) detectAndMeasure();
      }, delay)
    );
    checkResumeOnLoad();
    // The session timer (shown in the pill) resets per article view; the
    // global lifetime total lives only in storage and is untouched here.
    // Pause is a deliberate global setting, so it intentionally carries
    // over across article navigation instead of auto-clearing.
    state.breakNudgeShown = false;
    state.sessionElapsedMs = 0;
    state.lastScrollAt = Date.now();
    // Actually starts the clock now that we're on an article page — without
    // this, timerStartedAt never gets set on a normal load and the running
    // total silently never advances until some unrelated event (a settings
    // change, a visibility toggle) happens to call this first.
    refreshTimerRunState();
  }

  // Client-side (pushState/replaceState) navigation doesn't fire any event a
  // content script can listen for, and content scripts run in an isolated
  // JS world so they can't intercept the page's own history calls either —
  // polling location.href is the standard, dependency-free way around that.
  function watchForUrlChanges() {
    let lastHref = location.href;
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      flushSave();
      enterPage();
    }, 1000);
  }

  async function init() {
    await loadSettings();
    ui.init();
    watchSettingsChanges();
    watchForContentGrowth();
    watchForUrlChanges();
    setInterval(() => {
      if (!state.onArticlePage) return;
      // The pill shows this article view's own session time, not the
      // global lifetime total — that one only shows in the popup.
      ui.updateTimer(getCurrentSessionElapsedMs(), !!state.timerStartedAt);
      maybeShowBreakNudge();
      // Checkpoint the running total every few ticks (not every single one,
      // to limit storage writes) so a long uninterrupted read doesn't lose
      // progress if the tab crashes, and so the popup reflects reality
      // quickly if reopened.
      state.timerFlushTicks++;
      if (state.timerFlushTicks >= 3) {
        state.timerFlushTicks = 0;
        if (state.timerStartedAt) flushGlobalTimer();
      }
    }, 1000);

    enterPage();

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", () => {
      if (!state.onArticlePage) return;
      detectAndMeasure();
      onScroll();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushSave();
      refreshTimerRunState();
    });
    window.addEventListener("pagehide", () => {
      flushSave();
      flushGlobalTimer();
    });
  }

  setTimeout(init, 800);
})();
