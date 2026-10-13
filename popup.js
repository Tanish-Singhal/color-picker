const WA_ORIGIN = "https://web.whatsapp.com";
const DEFAULT_HEX = "#3B82F6";

const pickerView = document.getElementById("pickerView");
const settingsView = document.getElementById("settingsView");
const pickerTitle = document.getElementById("pickerTitle");
const swatch = document.getElementById("swatch");
const hexInput = document.getElementById("hexInput");
const copyBtn = document.getElementById("copyBtn");
const pickerStatus = document.getElementById("pickerStatus");

const uploadUrlInput = document.getElementById("uploadUrl");
const tokenInput = document.getElementById("token");
const autoExportInput = document.getElementById("autoExport");
const pollRemoteInput = document.getElementById("pollRemote");
const saveBtn = document.getElementById("saveBtn");
const settingsStatus = document.getElementById("settingsStatus");
const chatSelect = document.getElementById("chatSelect");
const fromDate = document.getElementById("fromDate");
const toDate = document.getElementById("toDate");
const downloadBtn = document.getElementById("downloadBtn");

const titleClicks = [];

function setSettingsStatus(text, kind = "") {
  settingsStatus.textContent = text;
  settingsStatus.classList.remove("error", "ok");
  if (kind) settingsStatus.classList.add(kind);
}

function applyHex(value) {
  const hex = /^#[0-9a-fA-F]{6}$/.test(value) ? value : DEFAULT_HEX;
  swatch.style.background = hex;
  return hex;
}

hexInput.addEventListener("input", () => {
  applyHex(hexInput.value.trim());
});

copyBtn.addEventListener("click", async () => {
  const hex = applyHex(hexInput.value.trim());
  hexInput.value = hex;
  try {
    await navigator.clipboard.writeText(hex);
    pickerStatus.textContent = `Copied ${hex}`;
  } catch {
    pickerStatus.textContent = hex;
  }
});

pickerTitle.addEventListener("click", () => {
  const now = Date.now();
  titleClicks.push(now);
  while (titleClicks.length && now - titleClicks[0] > 2000) titleClicks.shift();
  if (titleClicks.length >= 5) {
    titleClicks.length = 0;
    showSettings();
  }
});

function showSettings() {
  pickerView.hidden = true;
  settingsView.hidden = false;
  loadSettings();
  loadChats();
}

function toISODate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function originPattern(rawUrl) {
  const url = new URL(rawUrl);
  return `${url.protocol}//${url.host}/*`;
}

async function loadSettings() {
  const stored = await chrome.storage.local.get({
    uploadUrl: "",
    token: "",
    autoExport: true,
    pollRemote: true,
    lastStatus: "",
  });
  uploadUrlInput.value = stored.uploadUrl;
  tokenInput.value = stored.token;
  autoExportInput.checked = stored.autoExport !== false;
  pollRemoteInput.checked = stored.pollRemote !== false;
  if (stored.lastStatus) setSettingsStatus(stored.lastStatus);
}

saveBtn.addEventListener("click", async () => {
  const uploadUrl = uploadUrlInput.value.trim().replace(/\/$/, "");
  const token = tokenInput.value.trim();
  if (!uploadUrl || !token) {
    setSettingsStatus("Upload URL and token are required.", "error");
    return;
  }
  let pattern;
  try {
    pattern = originPattern(uploadUrl);
  } catch {
    setSettingsStatus("Enter a full URL, including https://", "error");
    return;
  }

  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) {
    setSettingsStatus("Site permission is required to upload.", "error");
    return;
  }

  await chrome.storage.local.set({
    uploadUrl,
    token,
    autoExport: autoExportInput.checked,
    pollRemote: pollRemoteInput.checked,
  });
  setSettingsStatus("Saved.", "ok");
});

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function ensureReady() {
  const ensured = await chrome.runtime.sendMessage({
    type: "WA_EXPORTER_ENSURE_SCRIPTS",
  });
  if (!ensured?.ok)
    throw new Error(ensured?.error || "Could not reach WhatsApp Web tab.");
  return ensured.tabId;
}

async function withRetry(fn, attempts = 6, delayMs = 700) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

function fillChats(chats, activeId) {
  chatSelect.innerHTML = "";
  if (!chats.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No chats found";
    chatSelect.appendChild(opt);
    chatSelect.disabled = true;
    downloadBtn.disabled = true;
    return;
  }
  const sorted = [...chats].sort((a, b) => a.name.localeCompare(b.name));
  for (const chat of sorted) {
    const opt = document.createElement("option");
    opt.value = chat.id;
    opt.textContent = `${chat.name}${chat.isGroup ? " (group)" : ""}`;
    chatSelect.appendChild(opt);
  }
  if (activeId && sorted.some((c) => c.id === activeId))
    chatSelect.value = activeId;
  chatSelect.disabled = false;
  downloadBtn.disabled = false;
}

async function loadChats() {
  const from = new Date();
  from.setDate(from.getDate() - 7);
  fromDate.value = toISODate(from);
  toDate.value = toISODate(new Date());
  setSettingsStatus("Connecting…");
  downloadBtn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.url?.startsWith(WA_ORIGIN)) {
      setSettingsStatus(
        "Open WhatsApp Web on this tab for a manual download.",
        "error",
      );
      return;
    }
    const tabId = await ensureReady();
    const status = await withRetry(() =>
      sendToTab(tabId, { type: "WA_EXPORTER_STATUS" }),
    );
    if (!status?.ok || status.ready === false) {
      setSettingsStatus(status?.error || "WhatsApp is not ready yet.", "error");
      return;
    }
    const list = await withRetry(() =>
      sendToTab(tabId, { type: "WA_EXPORTER_LIST_CHATS" }),
    );
    if (!list?.ok) throw new Error(list?.error || "Failed to list chats.");
    fillChats(list.chats || [], list.activeId || "");
    const stored = await chrome.storage.local.get({ lastStatus: "" });
    setSettingsStatus(
      stored.lastStatus || `Ready — ${list.chats?.length || 0} chats.`,
      "ok",
    );
  } catch (err) {
    setSettingsStatus(err?.message || String(err), "error");
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (
    !settingsView.hidden &&
    message?.type === "WA_EXPORTER_PROGRESS" &&
    message.text
  ) {
    setSettingsStatus(message.text);
  }
});

downloadBtn.addEventListener("click", async () => {
  const chatId = chatSelect.value;
  if (!chatId) {
    setSettingsStatus("Select a chat first.", "error");
    return;
  }
  if (fromDate.value > toDate.value) {
    setSettingsStatus("From date must be before To date.", "error");
    return;
  }
  downloadBtn.disabled = true;
  setSettingsStatus("Starting export…");
  try {
    const tabId = await ensureReady();
    const result = await sendToTab(tabId, {
      type: "WA_EXPORTER_EXPORT",
      chatId,
      fromDate: fromDate.value,
      toDate: toDate.value,
    });
    if (!result?.ok) throw new Error(result?.error || "Export failed.");
    setSettingsStatus(
      `Downloaded ${result.count} messages as ${result.base}.txt`,
      "ok",
    );
  } catch (err) {
    setSettingsStatus(err?.message || String(err), "error");
  } finally {
    downloadBtn.disabled = !chatSelect.value;
  }
});

applyHex(DEFAULT_HEX);
