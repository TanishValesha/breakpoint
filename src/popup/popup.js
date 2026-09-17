const QUEUE_KEY = "breakpoint:queue";

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function storageSet(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

const enabledToggle = document.getElementById("enabled-toggle");
const addCurrentBtn = document.getElementById("add-current");
const queueListEl = document.getElementById("queue-list");

async function loadSettings() {
  const data = await storageGet("breakpoint:enabled");
  enabledToggle.checked = data["breakpoint:enabled"] !== false;
}

enabledToggle.addEventListener("change", () => {
  storageSet({ "breakpoint:enabled": enabledToggle.checked });
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
  queue
    .slice()
    .reverse()
    .forEach((item) => {
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
      removeBtn.textContent = "✕";
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
