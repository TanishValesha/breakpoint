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
    }
    .bar-fill {
      height: 100%; width: 100%; background: #2563eb;
      transform: scaleX(0); transform-origin: left;
      transition: transform 80ms linear;
    }

    .pill {
      position: fixed; top: 10px; right: 16px; z-index: 2147483647;
      background: #1f2937; color: #fff; font-size: 12px; line-height: 1.4;
      border-radius: 999px; padding: 6px 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      opacity: 0.92;
    }

    .toast-stack {
      position: fixed; bottom: 20px; right: 16px; z-index: 2147483647;
      display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
    }
    .toast {
      background: #1f2937; color: #fff; font-size: 13px; border-radius: 10px;
      padding: 10px 12px; display: flex; align-items: center; gap: 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25); max-width: 280px;
    }
    .toast button.primary {
      all: unset; cursor: pointer; background: #2563eb; padding: 5px 10px;
      border-radius: 6px; font-size: 12px; white-space: nowrap;
    }
    .toast button.dismiss {
      all: unset; cursor: pointer; opacity: 0.6; font-size: 14px; padding: 0 2px;
    }
    .toast button.dismiss:hover { opacity: 1; }
  `;

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
      <div class="pill"><span class="pill-text">0% · -- min left</span></div>
      <div class="toast-stack"></div>
    `;

    els.fill = root.querySelector(".bar-fill");
    els.pillText = root.querySelector(".pill-text");
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
    dismissBtn.textContent = "✕";
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
    showResumeToast,
  };
})();
