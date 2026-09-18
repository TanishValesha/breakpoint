// Orchestrates article detection, scroll tracking, storage, and the injected UI.
(function () {
  const WPM = 200;
  const SAVE_DEBOUNCE_MS = 500;
  const MAX_RESUME_ENTRIES = 300;
  const MAX_RESUME_AGE_MS = 90 * 24 * 60 * 60 * 1000;

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
    timerElapsedMs: 0,
    timerStartedAt: null,
    timerManuallyPaused: false,
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
    const data = await storageGet(["breakpoint:enabled", "breakpoint:timerEnabled"]);
    state.enabled = data["breakpoint:enabled"] !== false;
    state.timerEnabled = data["breakpoint:timerEnabled"] !== false;
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
      state.timerElapsedMs += Date.now() - state.timerStartedAt;
      state.timerStartedAt = null;
    }
  }

  function getCurrentTimerElapsedMs() {
    if (!state.timerStartedAt) return state.timerElapsedMs;
    return state.timerElapsedMs + (Date.now() - state.timerStartedAt);
  }

  function resetTimer() {
    state.timerElapsedMs = 0;
    state.timerStartedAt = null;
    refreshTimerRunState();
  }

  function watchTimerMessages() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message.type !== "string" || !message.type.startsWith("timer:")) {
        return;
      }
      if (message.type === "timer:getState") {
        sendResponse({
          onArticlePage: state.onArticlePage,
          elapsedMs: getCurrentTimerElapsedMs(),
          running: !!state.timerStartedAt,
          manuallyPaused: state.timerManuallyPaused,
        });
        return;
      }
      if (message.type === "timer:pause") {
        state.timerManuallyPaused = true;
        refreshTimerRunState();
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "timer:resume") {
        state.timerManuallyPaused = false;
        refreshTimerRunState();
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "timer:reset") {
        resetTimer();
        sendResponse({ ok: true });
      }
    });
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
    // Each article view is its own reading session for the timer.
    state.timerManuallyPaused = false;
    resetTimer();
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
    watchTimerMessages();
    setInterval(() => {
      if (!state.onArticlePage) return;
      ui.updateTimer(getCurrentTimerElapsedMs(), !!state.timerStartedAt);
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
    window.addEventListener("pagehide", flushSave);
  }

  setTimeout(init, 800);
})();
