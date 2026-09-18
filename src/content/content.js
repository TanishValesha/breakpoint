// Orchestrates article detection, scroll tracking, storage, and the injected UI.
(function () {
  const WPM = 200;
  const SAVE_DEBOUNCE_MS = 500;
  const MAX_RESUME_ENTRIES = 300;
  const MAX_RESUME_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  const DEFAULT_NUDGE_THRESHOLD_MS = 15 * 60 * 1000;
  const SCROLL_IDLE_MS = 2500;

  const { findArticleElement, getWordCount, findHeadings } = window.Breakpoint.detect;
  const ui = window.Breakpoint.ui;

  function pageKey() {
    return location.origin + location.pathname;
  }
  function resumeStorageKey() {
    return "bp:" + pageKey();
  }
  function markedHeadingsStorageKey() {
    return "bpMarks:" + pageKey();
  }
  function reachedBreakpointsStorageKey() {
    return "bpReached:" + pageKey();
  }

  // Skip the site's own homepage/index — there's no article to track there,
  // and the widget would just be clutter on a listing page.
  function isHomePage() {
    const path = location.pathname.replace(/\/index\.(html?|php)$/i, "/");
    return path === "/" || path === "";
  }

  // User-managed escape hatch (popup: "Disabled sites") for when the
  // Arc90-style scorer in article-detect.js mistakes a non-article page
  // (Gmail, GitHub, etc.) for an article. Matched by exact hostname —
  // pasting the real address-bar URL always works; a guessed domain like
  // "gmail.com" won't match the real hostname "mail.google.com".
  function isDisabledSite() {
    return state.disabledSites.includes(location.hostname.toLowerCase());
  }

  const state = {
    enabled: true,
    disabledSites: [],
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
    nudgeThresholdMs: DEFAULT_NUDGE_THRESHOLD_MS,
    lastScrollAt: 0,
    // How many interval boundaries have already triggered a nudge this
    // article view — lets the reminder repeat every `nudgeThresholdMs`
    // instead of firing only once.
    nudgeIntervalsFired: 0,
    // Live section headings for the user-assigned breakpoints panel:
    // [{ element, label, percent }], recomputed on every detectAndMeasure().
    headings: [],
    // Labels the user has marked as their own breakpoints for this article,
    // persisted to storage. A Set of labels (not scroll positions) — see
    // toggleMarkHeading() for why matching by label is enough for this.
    markedHeadingLabels: new Set(),
    // Marked-heading labels already celebrated — persisted per article
    // (loadReachedBreakpoints/checkReachedBreakpoints), so resuming past
    // several already-passed breakpoints in one jump (e.g. clicking
    // "Resume" after a reload) doesn't re-fire all of them at once. Not
    // just an in-memory guard against scrolling back and forth like before.
    reachedBreakpointLabels: new Set(),
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
    computeHeadings();
    console.debug("[Breakpoint] detected article:", state.articleEl, {
      height: state.articleEl.offsetHeight,
      scrollableDistance: state.scrollableDistance,
      wordCount: state.wordCount,
      headings: state.headings.length,
    });
  }

  // Recomputes the live heading list (position + label) for the
  // breakpoints panel. Cheap enough to run on every detectAndMeasure() —
  // just a DOM query and a map, same cadence as word count.
  function computeHeadings() {
    state.headings = findHeadings(state.articleEl).map((h) => {
      const rect = h.element.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      const percent = Math.min(
        Math.max(((top - state.articleTop) / state.scrollableDistance) * 100, 0),
        100
      );
      return { element: h.element, label: h.label, percent };
    });
    renderHeadingsPanel();
  }

  function renderHeadingsPanel() {
    ui.renderHeadings(state.headings, state.markedHeadingLabels, jumpToHeading, toggleMarkHeading);
  }

  // Prefers the live element's current position (accurate even if the page
  // reflowed since detection); falls back to the last-known percent if that
  // element somehow isn't in the document anymore.
  function jumpToHeading(heading) {
    if (heading.element && heading.element.isConnected) {
      const rect = heading.element.getBoundingClientRect();
      window.scrollTo({ top: rect.top + window.scrollY, behavior: "smooth" });
      return;
    }
    const target = state.articleTop + (heading.percent / 100) * state.scrollableDistance;
    window.scrollTo({ top: target, behavior: "smooth" });
  }

  // Marking is keyed by the heading's text, not a stored scroll position —
  // simple, and robust enough across visits: if the article's headings
  // haven't changed, the same labels reappear and show as already marked.
  function toggleMarkHeading(heading) {
    if (state.markedHeadingLabels.has(heading.label)) {
      state.markedHeadingLabels.delete(heading.label);
      // Unmarking retires its "reached" record too — if the user re-marks
      // the same heading later, treat it as a fresh breakpoint rather than
      // one that's silently already celebrated.
      if (state.reachedBreakpointLabels.delete(heading.label)) {
        storageSet({
          [reachedBreakpointsStorageKey()]: Array.from(state.reachedBreakpointLabels),
        });
      }
    } else {
      state.markedHeadingLabels.add(heading.label);
    }
    storageSet({ [markedHeadingsStorageKey()]: Array.from(state.markedHeadingLabels) });
    renderHeadingsPanel();
  }

  async function loadMarkedHeadings() {
    const key = markedHeadingsStorageKey();
    const data = await storageGet(key);
    state.markedHeadingLabels = new Set(data[key] || []);
    renderHeadingsPanel();
  }

  async function loadReachedBreakpoints() {
    const key = reachedBreakpointsStorageKey();
    const data = await storageGet(key);
    state.reachedBreakpointLabels = new Set(data[key] || []);
  }

  // Celebrates reaching a breakpoint the user themself marked — unlike the
  // earlier auto-suggested heading nudge this replaced, it only ever fires
  // for headings the reader explicitly opted into, so it doesn't need the
  // break-nudge's scroll-idle wait: reaching a spot you deliberately chose
  // is a discrete, wanted moment, not an interruption to soften. Reached
  // labels are persisted (not just tracked in memory) so resuming past
  // several of them at once — e.g. reloading and clicking "Resume" — only
  // ever fires for genuinely new ones, never replaying past celebrations.
  function checkReachedBreakpoints(progress) {
    if (state.markedHeadingLabels.size === 0) return;
    const progressPct = progress * 100;
    let newlyReached = false;
    state.headings.forEach((heading) => {
      if (!state.markedHeadingLabels.has(heading.label)) return;
      if (state.reachedBreakpointLabels.has(heading.label)) return;
      if (progressPct < heading.percent) return;
      state.reachedBreakpointLabels.add(heading.label);
      newlyReached = true;
      ui.spawnConfetti();
      ui.showBreakpointReachedToast();
    });
    if (newlyReached) {
      storageSet({
        [reachedBreakpointsStorageKey()]: Array.from(state.reachedBreakpointLabels),
      });
    }
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
      checkReachedBreakpoints(progress);
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
      "breakpoint:nudgeThresholdMs",
      "breakpoint:timerPaused",
      "breakpoint:disabledSites",
    ]);
    state.enabled = data["breakpoint:enabled"] !== false;
    state.timerEnabled = data["breakpoint:timerEnabled"] !== false;
    state.nudgeEnabled = data["breakpoint:nudgeEnabled"] !== false;
    state.nudgeThresholdMs = data["breakpoint:nudgeThresholdMs"] || DEFAULT_NUDGE_THRESHOLD_MS;
    state.timerManuallyPaused = !!data["breakpoint:timerPaused"];
    state.disabledSites = data["breakpoint:disabledSites"] || [];
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
      if (changes["breakpoint:nudgeThresholdMs"]) {
        state.nudgeThresholdMs =
          changes["breakpoint:nudgeThresholdMs"].newValue || DEFAULT_NUDGE_THRESHOLD_MS;
      }
      if (changes["breakpoint:timerPaused"]) {
        state.timerManuallyPaused = !!changes["breakpoint:timerPaused"].newValue;
        refreshTimerRunState();
      }
      if (changes["breakpoint:disabledSites"]) {
        // Re-enters the page so a site just added/removed from the popup
        // takes effect immediately, not just on the next navigation.
        state.disabledSites = changes["breakpoint:disabledSites"].newValue || [];
        enterPage();
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

  // Repeats every `nudgeThresholdMs` of active reading on *this* article
  // view — 15 min preset means a nudge at 15, 30, 45 min, and so on — but
  // only ever fires once per interval boundary crossed, and only once the
  // reader isn't actively mid-scroll, so it lands in a natural lull rather
  // than interrupting. Deliberately uses the per-session counter, not the
  // lifetime total — otherwise, once your lifetime total ever crosses the
  // threshold, this would fire on every single article you open forever.
  // See CLAUDE.md for why this is a toast despite the earlier
  // heading-crossing nudge being removed — that one fired constantly
  // (every heading); this one is rare and paced to actual reading time.
  function maybeShowBreakNudge() {
    if (!state.enabled || !state.timerEnabled || !state.nudgeEnabled) return;
    const sessionElapsed = getCurrentSessionElapsedMs();
    const intervalsPassed = Math.floor(sessionElapsed / state.nudgeThresholdMs);
    if (intervalsPassed <= state.nudgeIntervalsFired) return;
    if (Date.now() - state.lastScrollAt < SCROLL_IDLE_MS) return;
    state.nudgeIntervalsFired = intervalsPassed;
    ui.showBreakNudgeToast(Math.round(sessionElapsed / 60000));
  }

  // Runs whenever we land on a page — both on the real initial load and on
  // every client-side navigation an SPA like Medium does afterwards, since
  // those never reload the document (see watchForUrlChanges).
  function enterPage() {
    if (isHomePage() || isDisabledSite()) {
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
    loadMarkedHeadings();
    // Loads which marked breakpoints this article has already celebrated
    // (persisted, not reset per view) — otherwise resuming past several of
    // them at once would re-fire every one of them on every reload.
    loadReachedBreakpoints();
    // The session timer (shown in the pill) resets per article view; the
    // global lifetime total lives only in storage and is untouched here.
    // Pause is a deliberate global setting, so it intentionally carries
    // over across article navigation instead of auto-clearing.
    state.nudgeIntervalsFired = 0;
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
