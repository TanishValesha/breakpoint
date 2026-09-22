const QUEUE_KEY = "breakpoint:queue";
const DISABLED_SITES_KEY = "breakpoint:disabledSites";
const DEFAULT_NUDGE_THRESHOLD_MS = 15 * 60 * 1000;
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
const disabledSiteInput = document.getElementById("disabled-site-input");
const disabledSiteAddBtn = document.getElementById("disabled-site-add");
const disabledSitesListEl = document.getElementById("disabled-sites-list");
const disableCurrentBtn = document.getElementById("disable-current");
const nudgePresetButtons = Array.from(document.querySelectorAll(".preset-btn"));

async function loadSettings() {
  const data = await storageGet([
    "breakpoint:enabled",
    "breakpoint:timerEnabled",
    "breakpoint:nudgeEnabled",
    "breakpoint:nudgeThresholdMs",
  ]);
  enabledToggle.checked = data["breakpoint:enabled"] !== false;
  timerEnabledToggle.checked = data["breakpoint:timerEnabled"] !== false;
  nudgeEnabledToggle.checked = data["breakpoint:nudgeEnabled"] !== false;

  const activeMinutes = Math.round(
    (data["breakpoint:nudgeThresholdMs"] || DEFAULT_NUDGE_THRESHOLD_MS) / 60000
  );
  nudgePresetButtons.forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.minutes) === activeMinutes);
  });
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

nudgePresetButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const minutes = Number(btn.dataset.minutes);
    storageSet({ "breakpoint:nudgeThresholdMs": minutes * 60000 });
    nudgePresetButtons.forEach((b) => b.classList.toggle("active", b === btn));
  });
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

// window.confirm() renders unreliably inside an extension popup's small,
// fixed-size viewport — its buttons can end up clipped/unreachable — so
// this confirms inline instead: first click arms it, second click within
// a few seconds actually resets, otherwise it quietly reverts.
let resetArmedTimeout = null;

function armResetConfirm() {
  timerResetBtn.textContent = "Sure?";
  timerResetBtn.classList.add("confirm");
  resetArmedTimeout = setTimeout(disarmResetConfirm, 3000);
}

function disarmResetConfirm() {
  clearTimeout(resetArmedTimeout);
  resetArmedTimeout = null;
  timerResetBtn.textContent = "Reset";
  timerResetBtn.classList.remove("confirm");
}

timerResetBtn.addEventListener("click", async () => {
  if (!resetArmedTimeout) {
    armResetConfirm();
    return;
  }
  disarmResetConfirm();
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
    link.className = "entry-label";
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

// Accepts either a bare hostname ("github.com") or a full pasted URL
// ("https://github.com/foo") — whichever's easiest to grab — and matches
// content.js's exact-hostname check, so it's worth pasting the real
// address-bar URL rather than a guessed domain (e.g. "gmail.com" won't
// match the real hostname "mail.google.com").
function parseHostname(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).hostname.toLowerCase() || null;
  } catch {
    try {
      return new URL("https://" + trimmed).hostname.toLowerCase() || null;
    } catch {
      return null;
    }
  }
}

async function loadDisabledSites() {
  const data = await storageGet(DISABLED_SITES_KEY);
  return data[DISABLED_SITES_KEY] || [];
}

async function renderDisabledSites() {
  const sites = await loadDisabledSites();
  disabledSitesListEl.innerHTML = "";
  if (sites.length === 0) {
    disabledSitesListEl.innerHTML = `<li class="empty">No sites disabled</li>`;
    return;
  }
  sites.forEach((hostname) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "entry-label";
    label.textContent = hostname;
    const removeBtn = document.createElement("button");
    removeBtn.innerHTML = CLOSE_ICON;
    removeBtn.setAttribute("aria-label", `Re-enable Breakpoint on ${hostname}`);
    removeBtn.addEventListener("click", async () => {
      const updated = sites.filter((s) => s !== hostname);
      await storageSet({ [DISABLED_SITES_KEY]: updated });
      renderDisabledSites();
    });
    li.appendChild(label);
    li.appendChild(removeBtn);
    disabledSitesListEl.appendChild(li);
  });
}

async function commitDisabledSite(hostname) {
  if (!hostname) return;
  const sites = await loadDisabledSites();
  if (sites.includes(hostname)) return;
  sites.push(hostname);
  await storageSet({ [DISABLED_SITES_KEY]: sites });
  renderDisabledSites();
}

async function addDisabledSite() {
  const hostname = parseHostname(disabledSiteInput.value);
  disabledSiteInput.value = "";
  await commitDisabledSite(hostname);
}

disabledSiteAddBtn.addEventListener("click", addDisabledSite);
disabledSiteInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addDisabledSite();
});

// Same activeTab-gated tab lookup the queue's "+ Add this page" button
// already relies on — no extra permission needed.
disableCurrentBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;
  await commitDisabledSite(parseHostname(tab.url));
});

loadSettings();
renderQueue();
renderDisabledSites();
refreshTimerUI();
