const QUEUE_KEY = "breakpoint:queue";
const CLOSE_ICON = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function storageSet(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

const enabledToggle = document.getElementById("enabled-toggle");
const timerEnabledToggle = document.getElementById("timer-enabled-toggle");
const nudgeEnabledToggle = document.getElementById("nudge-enabled-toggle");
const timerReadout = document.getElementById("timer-readout");
const timerPauseResumeBtn = document.getElementById("timer-pause-resume");
const timerResetBtn = document.getElementById("timer-reset");
const addCurrentBtn = document.getElementById("add-current");
const queueListEl = document.getElementById("queue-list");

async function loadSettings() {
  const data = await storageGet([
    "breakpoint:enabled",
    "breakpoint:timerEnabled",
    "breakpoint:nudgeEnabled",
  ]);
  enabledToggle.checked = data["breakpoint:enabled"] !== false;
  timerEnabledToggle.checked = data["breakpoint:timerEnabled"] !== false;
  nudgeEnabledToggle.checked = data["breakpoint:nudgeEnabled"] !== false;
}

enabledToggle.addEventListener("change", () => {
  storageSet({ "breakpoint:enabled": enabledToggle.checked });
});

timerEnabledToggle.addEventListener("change", () => {
  storageSet({ "breakpoint:timerEnabled": timerEnabledToggle.checked });
});

nudgeEnabledToggle.addEventListener("change", () => {
  storageSet({ "breakpoint:nudgeEnabled": nudgeEnabledToggle.checked });
});

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  if (hh > 0) return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

// The timer is global now — total/paused state live in storage rather than
// a specific tab's live memory, so the popup just reads/writes storage
// directly instead of messaging the active tab.
async function refreshTimerUI() {
  const data = await storageGet(["breakpoint:timerTotalMs", "breakpoint:timerPaused"]);
  timerReadout.textContent = formatElapsed(data["breakpoint:timerTotalMs"] || 0);
  timerPauseResumeBtn.textContent = data["breakpoint:timerPaused"] ? "Resume" : "Pause";
}

timerPauseResumeBtn.addEventListener("click", async () => {
  const resuming = timerPauseResumeBtn.textContent === "Resume";
  await storageSet({ "breakpoint:timerPaused": !resuming });
  refreshTimerUI();
});

timerResetBtn.addEventListener("click", async () => {
  if (!confirm("Reset your lifetime reading timer to 0? This can't be undone.")) return;
  await storageSet({ "breakpoint:timerTotalMs": 0 });
  refreshTimerUI();
});

async function loadQueue() {
  const data = await storageGet(QUEUE_KEY);
  return data[QUEUE_KEY] || [];
}

async function renderQueue() {
  const queue = await loadQueue();
  queueListEl.innerHTML = "";
  if (queue.length === 0) {
    queueListEl.innerHTML = `<li class="empty">No articles queued</li>`;
    return;
  }
  queue.forEach((item) => {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = item.url;
    link.textContent = item.title || item.url;
    link.title = item.url;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: item.url });
    });
    const removeBtn = document.createElement("button");
    removeBtn.innerHTML = CLOSE_ICON;
    removeBtn.setAttribute("aria-label", `Remove ${item.title || item.url} from queue`);
    removeBtn.addEventListener("click", async () => {
      const updated = queue.filter((q) => q.url !== item.url);
      await storageSet({ [QUEUE_KEY]: updated });
      renderQueue();
    });
    li.appendChild(link);
    li.appendChild(removeBtn);
    queueListEl.appendChild(li);
  });
}

addCurrentBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;
  const queue = await loadQueue();
  if (queue.some((q) => q.url === tab.url)) return;
  queue.push({ url: tab.url, title: tab.title || tab.url, addedAt: Date.now() });
  await storageSet({ [QUEUE_KEY]: queue });
  renderQueue();
});

loadSettings();
renderQueue();
refreshTimerUI();
