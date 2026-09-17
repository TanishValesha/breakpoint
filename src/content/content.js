// Orchestrates article detection, scroll tracking, storage, and the injected UI.
(function () {
  const WPM = 200;
  const SAVE_DEBOUNCE_MS = 500;
  const MAX_RESUME_ENTRIES = 300;
  const MAX_RESUME_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  const BREAKPOINT_MIN_PERCENT = 5;
  const BREAKPOINT_MAX_PERCENT = 95;
  const BREAKPOINT_MIN_GAP_PERCENT = 8;

  const { findArticleElement, getWordCount, findHeadings } = window.Breakpoint.detect;
  const ui = window.Breakpoint.ui;

  function pageKey() {
    return location.origin + location.pathname;
  }
  function resumeStorageKey() {
    return "bp:" + pageKey();
  }

  const state = {
    enabled: true,
    articleEl: null,
    articleTop: 0,
    scrollableDistance: 1,
    wordCount: 0,
    breakpoints: [],
    saveTimer: null,
    tickScheduled: false,
    pendingSave: null,
    growthTimer: null,
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
    computeBreakpoints();
    console.debug("[Breakpoint] detected article:", state.articleEl, {
      height: state.articleEl.offsetHeight,
      scrollableDistance: state.scrollableDistance,
      wordCount: state.wordCount,
      breakpoints: state.breakpoints,
    });
  }

  // Section headings are natural pause points. Compute each one's scroll
  // percentage the same way reading progress is computed, so a breakpoint is
  // "reached" exactly when the progress bar crosses that value. Headings too
  // close together (sub-subheadings) are deduped to avoid a toast cluster.
  function computeBreakpoints() {
    const headings = findHeadings(state.articleEl);
    const candidates = headings
      .map((h) => {
        const rect = h.element.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        const percent = ((top - state.articleTop) / state.scrollableDistance) * 100;
        return { percent, label: h.label };
      })
      .filter(
        (bp) => bp.percent >= BREAKPOINT_MIN_PERCENT && bp.percent <= BREAKPOINT_MAX_PERCENT
      )
      .sort((a, b) => a.percent - b.percent);

    const deduped = [];
    candidates.forEach((bp) => {
      const last = deduped[deduped.length - 1];
      if (!last || bp.percent - last.percent >= BREAKPOINT_MIN_GAP_PERCENT) {
        deduped.push(bp);
      }
    });

    state.breakpoints = deduped;
    ui.setBreakpointMarkers(state.breakpoints);
  }

  // Sites like Medium hydrate/lazy-render article content client-side, so the
  // element we picked at init can still be growing after our first measurement.
  // Watch for DOM growth and re-detect (debounced) so bounds don't stay stale.
  function watchForContentGrowth() {
    const observer = new MutationObserver(() => {
      if (state.growthTimer) clearTimeout(state.growthTimer);
      state.growthTimer = setTimeout(detectAndMeasure, 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function getProgress() {
    const raw = (window.scrollY - state.articleTop) / state.scrollableDistance;
    return Math.min(Math.max(raw, 0), 1);
  }

  function scheduleSave(percent, scrollY) {
    state.pendingSave = { percent, scrollY, updatedAt: Date.now() };
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    if (!state.pendingSave) return;
    const entry = {
      url: location.href,
      title: document.title,
      percent: state.pendingSave.percent * 100,
      scrollY: state.pendingSave.scrollY,
      updatedAt: state.pendingSave.updatedAt,
    };
    storageSet({ [resumeStorageKey()]: entry });
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
      if (!state.enabled) return;

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
    const data = await storageGet("breakpoint:enabled");
    state.enabled = data["breakpoint:enabled"] !== false;
  }

  function watchSettingsChanges() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes["breakpoint:enabled"]) {
        state.enabled = changes["breakpoint:enabled"].newValue !== false;
        ui.setVisible(state.enabled);
      }
    });
  }

  async function init() {
    await loadSettings();
    ui.init();
    ui.setVisible(state.enabled);
    watchSettingsChanges();

    detectAndMeasure();
    onScroll();
    watchForContentGrowth();
    // Medium-style SPAs keep hydrating content after document_idle; re-detect
    // a couple more times before the user is likely to have scrolled yet.
    [1500, 3000].forEach((delay) => setTimeout(detectAndMeasure, delay));

    await checkResumeOnLoad();

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", () => {
      detectAndMeasure();
      onScroll();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushSave();
    });
    window.addEventListener("pagehide", flushSave);
  }

  setTimeout(init, 800);
})();
