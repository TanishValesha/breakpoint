// Injects the progress bar and toasts inside a Shadow DOM so nothing leaks
// into (or is affected by) the host page's styles.
(function () {
  window.Breakpoint = window.Breakpoint || {};

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }

    .bar-track {
      position: fixed; top: 0; left: 0; width: 100%; height: 4px;
      background: rgba(0,0,0,0.08); z-index: 2147483647;
      box-shadow: 0 1px 2px rgba(0,0,0,0.06);
    }
    .bar-fill {
      height: 100%; width: 100%;
      background: linear-gradient(90deg, #2563eb, #3b82f6);
      transform: scaleX(0); transform-origin: left;
      transition: transform 80ms linear;
    }

    .pill {
      position: fixed; top: 10px; right: 16px; z-index: 2147483647;
      background: linear-gradient(90deg, #2563eb, #3b82f6); color: #fff; font-size: 12px; font-weight: 500;
      line-height: 1.4; letter-spacing: 0.01em; text-shadow: 0 1px 2px rgba(0,0,0,0.25);
      border-radius: 999px; padding: 6px 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      opacity: 0.92; display: flex; align-items: center; gap: 8px;
    }
    .pill-timer {
      display: flex; align-items: center; gap: 3px; opacity: 0.85;
      border-left: 1px solid rgba(255,255,255,0.3); padding-left: 8px;
    }
    .pill-timer.paused { opacity: 0.5; }

    .pill-headings-toggle {
      all: unset; cursor: pointer; display: flex; align-items: center;
      opacity: 0.85; padding: 2px; border-radius: 4px;
      border-left: 1px solid rgba(255,255,255,0.3); padding-left: 8px;
    }
    .pill-headings-toggle:hover { opacity: 1; }
    .pill-headings-toggle:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

    .headings-panel {
      position: fixed; top: 44px; right: 16px; z-index: 2147483647;
      background: #fff; color: #1f2937;
      border-radius: 10px;
      width: 240px; max-height: 260px; overflow-y: auto;
      padding: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.18);
      display: none;
    }
    .headings-panel.open { display: block; }

    .heading-row {
      display: flex; align-items: center; gap: 6px;
      padding: 2px; border-radius: 6px;
    }
    .heading-row:hover { background: rgba(0,0,0,0.05); }

    .heading-label-btn {
      all: unset; cursor: pointer; flex: 1; min-width: 0;
      font-size: 12px; font-weight: 700; padding: 6px 4px; border-radius: 6px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .heading-label-btn:hover { text-decoration: underline; }
    .heading-label-btn:focus-visible { outline: 2px solid #2563eb; outline-offset: -2px; }

    .heading-mark-btn {
      all: unset; cursor: pointer; display: flex; padding: 4px;
      border-radius: 4px; opacity: 0.6; flex-shrink: 0;
    }
    .heading-mark-btn:hover { opacity: 1; }
    .heading-mark-btn.marked { opacity: 1; color: #2563eb; }
    .heading-mark-btn:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }

    .headings-empty {
      font-size: 12px; color: #6b7280; padding: 10px 6px; text-align: center;
    }

    .toast-stack {
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      z-index: 2147483647;
      display: flex; flex-direction: column; gap: 8px; align-items: center;
    }
    .toast {
      background: linear-gradient(90deg, #2563eb, #3b82f6); color: #fff; font-size: 13px;
      text-shadow: 0 1px 2px rgba(0,0,0,0.25);
      border-radius: 10px;
      padding: 10px 12px; display: flex; align-items: center; gap: 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25); max-width: 280px;
      animation: bp-toast-in 160ms ease-out;
    }
    .toast button.primary {
      all: unset; cursor: pointer; background: rgba(255,255,255,0.95); color: #1d4ed8;
      text-shadow: none; padding: 5px 10px;
      border-radius: 6px; font-size: 12px; font-weight: 600; white-space: nowrap;
      transition: background 100ms ease-out;
    }
    .toast button.primary:hover { background: #fff; }
    .toast button.dismiss {
      all: unset; cursor: pointer; opacity: 0.6; display: flex; padding: 3px;
      border-radius: 4px; transition: opacity 100ms ease-out;
    }
    .toast button.dismiss:hover { opacity: 1; }
    .toast button.primary:focus-visible,
    .toast button.dismiss:focus-visible {
      outline: 2px solid #fff; outline-offset: 2px;
    }
    .toast.glow {
      animation: bp-toast-in 160ms ease-out, bp-toast-glow 1400ms ease-in-out 200ms 2;
    }
    .toast.light {
      background: #fff; color: #1f2937; text-shadow: none;
      border-radius: 999px; box-shadow: 0 4px 16px rgba(0,0,0,0.18);
    }
    .toast.light button.primary:focus-visible,
    .toast.light button.dismiss:focus-visible {
      outline-color: #2563eb;
    }
    .toast-icon { display: flex; flex-shrink: 0; }
    @keyframes bp-toast-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes bp-toast-glow {
      0%, 100% { box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
      50% { box-shadow: 0 2px 8px rgba(0,0,0,0.25), 0 0 16px 4px rgba(59,130,246,0.6); }
    }
    @media (prefers-reduced-motion: reduce) {
      .toast, .toast.glow { animation: none; }
    }

    .confetti-canvas {
      position: fixed; inset: 0; width: 100%; height: 100%;
      pointer-events: none; z-index: 2147483647;
    }
  `;

  const CLOSE_ICON = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  const CLOCK_ICON = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.2"/><path d="M6 3.2V6l2 1.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const LIST_ICON = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 3H10M2 6H10M2 9H10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
  const BOOKMARK_OUTLINE = `<svg width="10" height="12" viewBox="0 0 10 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1.5 1.5H8.5V10.5L5 8L1.5 10.5V1.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
  const BOOKMARK_FILLED = `<svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1.5 1.5H8.5V10.5L5 8L1.5 10.5V1.5Z"/></svg>`;
  const TICK_ICON = `<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="7" cy="7" r="6" stroke="#2563eb" stroke-width="1.3"/><path d="M4.3 7.2L6.1 9L9.7 5.2" stroke="#2563eb" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  let root = null;
  let els = {};
  let confettiInstance = null;

  function init() {
    if (root) return;
    const host = document.createElement("div");
    host.id = "breakpoint-extension-root";
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
      <style>${STYLES}</style>
      <div class="bar-track"><div class="bar-fill"></div></div>
      <div class="pill">
        <span class="pill-text">0% · -- min left</span>
        <span class="pill-timer" title="Time spent on this article — see the popup for your all-time total">${CLOCK_ICON}<span class="pill-timer-text">0:00</span></span>
        <button class="pill-headings-toggle" aria-expanded="false" aria-label="Section breakpoints" title="Section breakpoints">${LIST_ICON}</button>
      </div>
      <div class="headings-panel"></div>
      <canvas class="confetti-canvas"></canvas>
      <div class="toast-stack"></div>
    `;

    els.fill = root.querySelector(".bar-fill");
    els.pillText = root.querySelector(".pill-text");
    els.pillTimer = root.querySelector(".pill-timer");
    els.pillTimerText = root.querySelector(".pill-timer-text");
    els.headingsToggle = root.querySelector(".pill-headings-toggle");
    els.headingsPanel = root.querySelector(".headings-panel");
    els.confettiCanvas = root.querySelector(".confetti-canvas");
    els.toastStack = root.querySelector(".toast-stack");

    els.headingsToggle.addEventListener("click", () => {
      const open = els.headingsPanel.classList.toggle("open");
      els.headingsToggle.setAttribute("aria-expanded", String(open));
    });

    // canvas-confetti (vendored in src/content/vendor/, loaded before this
    // script) defaults to injecting its own canvas into document.body —
    // scoping it to a canvas we own inside the Shadow DOM instead keeps it
    // consistent with the rest of the UI living entirely in our own root.
    // useWorker is left off: it needs Worker/Blob creation, which some
    // sites' CSP blocks, and a silently-broken celebration is worse than
    // slightly less optimal main-thread rendering.
    if (window.confetti && window.confetti.create) {
      confettiInstance = window.confetti.create(els.confettiCanvas, { resize: true });
    }
  }

  function setVisible(visible) {
    if (!root) return;
    root.host.style.display = visible ? "" : "none";
  }

  // headings: [{ label, percent }]; markedLabels: Set of labels already
  // saved as breakpoints. Clicking a row's text jumps there; the separate
  // bookmark icon toggles whether it's saved — two independent actions so
  // neither is hidden behind ambiguous double-tap behavior.
  function renderHeadings(headings, markedLabels, onJump, onToggleMark) {
    if (!root) return;
    els.headingsPanel.innerHTML = "";
    if (!headings || headings.length === 0) {
      els.headingsPanel.innerHTML = `<div class="headings-empty">No sections detected</div>`;
      return;
    }
    headings.forEach((heading) => {
      const marked = markedLabels.has(heading.label);
      const row = document.createElement("div");
      row.className = "heading-row";

      const labelBtn = document.createElement("button");
      labelBtn.className = "heading-label-btn";
      labelBtn.textContent = heading.label;
      labelBtn.title = heading.label;
      labelBtn.addEventListener("click", () => onJump(heading));
      row.appendChild(labelBtn);

      const markBtn = document.createElement("button");
      markBtn.className = marked ? "heading-mark-btn marked" : "heading-mark-btn";
      markBtn.innerHTML = marked ? BOOKMARK_FILLED : BOOKMARK_OUTLINE;
      markBtn.setAttribute("aria-pressed", String(marked));
      markBtn.setAttribute(
        "aria-label",
        marked ? `Remove breakpoint at ${heading.label}` : `Save breakpoint at ${heading.label}`
      );
      markBtn.addEventListener("click", () => onToggleMark(heading));
      row.appendChild(markBtn);

      els.headingsPanel.appendChild(row);
    });
  }

  function updateProgress(percent, minutesRemaining) {
    if (!root) return;
    const pct = Math.round(percent);
    els.fill.style.transform = `scaleX(${pct / 100})`;
    const timeLabel =
      minutesRemaining == null
        ? ""
        : minutesRemaining < 1
        ? " · <1 min left"
        : ` · ${Math.round(minutesRemaining)} min left`;
    els.pillText.textContent = `${pct}%${timeLabel}`;
  }

  function updateTimer(elapsedMs, running) {
    if (!root) return;
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const hh = Math.floor(totalSeconds / 3600);
    const mm = Math.floor((totalSeconds % 3600) / 60);
    const ss = totalSeconds % 60;
    els.pillTimerText.textContent =
      hh > 0
        ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
        : `${mm}:${String(ss).padStart(2, "0")}`;
    els.pillTimer.classList.toggle("paused", !running);
  }

  function makeToast(message, { primaryLabel, onPrimary, onDismiss, autoHideMs, glow, light, icon } = {}) {
    if (!root) return;
    const toast = document.createElement("div");
    toast.className = glow ? "toast glow" : "toast";
    if (light) toast.classList.add("light");

    if (icon) {
      const iconWrap = document.createElement("span");
      iconWrap.className = "toast-icon";
      iconWrap.innerHTML = icon;
      toast.appendChild(iconWrap);
    }

    const text = document.createElement("span");
    text.textContent = message;
    toast.appendChild(text);

    if (primaryLabel) {
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = primaryLabel;
      btn.addEventListener("click", () => {
        onPrimary && onPrimary();
        remove();
      });
      toast.appendChild(btn);
    }

    const dismissBtn = document.createElement("button");
    dismissBtn.className = "dismiss";
    dismissBtn.innerHTML = CLOSE_ICON;
    dismissBtn.setAttribute("aria-label", "Dismiss");
    dismissBtn.addEventListener("click", () => {
      onDismiss && onDismiss();
      remove();
    });
    toast.appendChild(dismissBtn);

    function remove() {
      toast.remove();
    }

    els.toastStack.appendChild(toast);
    if (autoHideMs) setTimeout(remove, autoHideMs);
    return remove;
  }

  function showResumeToast(percent, onResume, onDismiss) {
    makeToast(`Resume reading at ${Math.round(percent)}%?`, {
      primaryLabel: "Resume",
      onPrimary: onResume,
      onDismiss,
      autoHideMs: 8000,
    });
  }

  function showBreakNudgeToast(minutes) {
    makeToast(`${minutes} min in — good time for a break?`, {
      autoHideMs: 10000,
      glow: true,
    });
  }

  function showBreakpointReachedToast() {
    makeToast("Breakpoint reached — take a break?", {
      autoHideMs: 8000,
      light: true,
      icon: TICK_ICON,
    });
  }

  // Adapted from canvas-confetti's "Side Cannons" preset (also what
  // MagicUI's Confetti component wraps): two cannons firing for 3 seconds,
  // 2 particles per frame per side via requestAnimationFrame. Origin moved
  // from the reference's mid-edge (y: 0.5) to the bottom corners (y: 1) per
  // request — angle 60/120 already aimed inward-and-upward, so at a bottom
  // corner that reads as a classic corner cannon shooting up into the
  // screen. spread 55 and startVelocity 60 are the preset's own values,
  // left untouched.
  function fireSideCannons() {
    if (!confettiInstance) return;
    const end = Date.now() + 3 * 1000;
    const colors = ["#a786ff", "#fd8bbc", "#eca184", "#f8deb1"];

    (function frame() {
      if (Date.now() > end) return;
      confettiInstance({
        particleCount: 2,
        angle: 60,
        spread: 55,
        startVelocity: 60,
        origin: { x: 0, y: 1 },
        colors: colors,
      });
      confettiInstance({
        particleCount: 2,
        angle: 120,
        spread: 55,
        startVelocity: 60,
        origin: { x: 1, y: 1 },
        colors: colors,
      });
      requestAnimationFrame(frame);
    })();
  }

  // Skipped outright under prefers-reduced-motion, same as the toast
  // animations — a 3-second cannon burst is exactly the kind of spatial
  // motion that guidance asks to drop rather than just soften.
  function spawnConfetti() {
    if (!root) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    fireSideCannons();
  }

  window.Breakpoint.ui = {
    init,
    setVisible,
    updateProgress,
    updateTimer,
    renderHeadings,
    showResumeToast,
    showBreakNudgeToast,
    showBreakpointReachedToast,
    spawnConfetti,
  };
})();
