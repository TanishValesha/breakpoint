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

    .toast-stack {
      position: fixed; bottom: 20px; right: 16px; z-index: 2147483647;
      display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
    }
    .toast {
      background: #1f2937; color: #fff; font-size: 13px;text-shadow: 0 1px 2px rgba(0,0,0,0.25);
      border-radius: 10px;
      padding: 10px 12px; display: flex; align-items: center; gap: 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25); max-width: 280px;
      animation: bp-toast-in 160ms ease-out;
    }
    .toast button.primary {
      all: unset; cursor: pointer; background: linear-gradient(90deg, #2563eb, #3b82f6); padding: 5px 10px;
      border-radius: 6px; font-size: 12px; white-space: nowrap;
      transition: background 100ms ease-out;
    }
    .toast button.primary:hover { background: #1d4ed8; }
    .toast button.dismiss {
      all: unset; cursor: pointer; opacity: 0.6; display: flex; padding: 3px;
      border-radius: 4px; transition: opacity 100ms ease-out;
    }
    .toast button.dismiss:hover { opacity: 1; }
    .toast button.primary:focus-visible,
    .toast button.dismiss:focus-visible {
      outline: 2px solid #93c5fd; outline-offset: 2px;
    }
    @keyframes bp-toast-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .toast { animation: none; }
    }
  `;

  const CLOSE_ICON = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  const CLOCK_ICON = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.2"/><path d="M6 3.2V6l2 1.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  let root = null;
  let els = {};

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
        <span class="pill-timer">${CLOCK_ICON}<span class="pill-timer-text">0:00</span></span>
      </div>
      <div class="toast-stack"></div>
    `;

    els.fill = root.querySelector(".bar-fill");
    els.pillText = root.querySelector(".pill-text");
    els.pillTimer = root.querySelector(".pill-timer");
    els.pillTimerText = root.querySelector(".pill-timer-text");
    els.toastStack = root.querySelector(".toast-stack");
  }

  function setVisible(visible) {
    if (!root) return;
    root.host.style.display = visible ? "" : "none";
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
    const mm = Math.floor(totalSeconds / 60);
    const ss = totalSeconds % 60;
    els.pillTimerText.textContent = `${mm}:${String(ss).padStart(2, "0")}`;
    els.pillTimer.classList.toggle("paused", !running);
  }

  function makeToast(message, { primaryLabel, onPrimary, onDismiss, autoHideMs } = {}) {
    if (!root) return;
    const toast = document.createElement("div");
    toast.className = "toast";
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

  window.Breakpoint.ui = {
    init,
    setVisible,
    updateProgress,
    updateTimer,
    showResumeToast,
  };
})();
