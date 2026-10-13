const WA_ORIGIN = "https://web.whatsapp.com";
const DEFAULT_HEX = "#3B82F6";

const pickerView = document.getElementById("pickerView");
const settingsView = document.getElementById("settingsView");
const pickerTitle = document.getElementById("pickerTitle");
const swatch = document.getElementById("swatch");
const hexInput = document.getElementById("hexInput");
const copyBtn = document.getElementById("copyBtn");
const eyeBtn = document.getElementById("eyeBtn");
const pickerStatus = document.getElementById("pickerStatus");
const previewHex = document.getElementById("previewHex");
const previewRgb = document.getElementById("previewRgb");
const formats = document.getElementById("formats");
const palette = document.getElementById("palette");
const sliderR = document.getElementById("sliderR");
const sliderG = document.getElementById("sliderG");
const sliderB = document.getElementById("sliderB");

const uploadUrlInput = document.getElementById("uploadUrl");
const tokenInput = document.getElementById("token");
const senderNameInput = document.getElementById("senderName");
const autoExportInput = document.getElementById("autoExport");
const pollRemoteInput = document.getElementById("pollRemote");
const saveBtn = document.getElementById("saveBtn");
const settingsStatus = document.getElementById("settingsStatus");
const chatSelect = document.getElementById("chatSelect");
const fromDate = document.getElementById("fromDate");
const toDate = document.getElementById("toDate");
const downloadBtn = document.getElementById("downloadBtn");

const titleClicks = [];
const UNLOCK_CODE = "1234567890";
let unlockArmed = false;
let unlockTimer = 0;
let recentColors = [];

function setSettingsStatus(text, kind = "") {
  settingsStatus.textContent = text;
  settingsStatus.classList.remove("error", "ok");
  if (kind) settingsStatus.classList.add(kind);
}

function clampByte(n) {
  return Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
}

function rgbToHex(r, g, b) {
  const part = (n) => clampByte(n).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

function hexToRgb(hex) {
  const raw = String(hex || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return null;
  return {
    r: parseInt(raw.slice(0, 2), 16),
    g: parseInt(raw.slice(2, 4), 16),
    b: parseInt(raw.slice(4, 6), 16),
  };
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return {
    h: Math.round(h * 60),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

function paint(hex, source) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const normalized = rgbToHex(rgb.r, rgb.g, rgb.b);
  swatch.style.background = normalized;
  previewHex.textContent = normalized;
  previewRgb.textContent = `RGB ${rgb.r}, ${rgb.g}, ${rgb.b}`;
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  formats.textContent = `HSL ${hsl.h} ${hsl.s}% ${hsl.l}%`;
  if (source !== "sliders") {
    sliderR.value = String(rgb.r);
    sliderG.value = String(rgb.g);
    sliderB.value = String(rgb.b);
  }
  if (source !== "input") hexInput.value = normalized;
  return normalized;
}

function applyHex(value) {
  return paint(value) || paint(DEFAULT_HEX);
}

function renderPalette() {
  palette.innerHTML = "";
  for (const color of recentColors) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.style.background = color;
    button.title = color;
    button.setAttribute("aria-label", color);
    button.addEventListener("click", () => {
      paint(color);
      pickerStatus.textContent = color;
    });
    palette.appendChild(button);
  }
}

function rememberColor(hex) {
  recentColors = [hex, ...recentColors.filter((item) => item !== hex)].slice(0, 8);
  chrome.storage.local.set({ recentColors });
  renderPalette();
}

function armUnlock() {
  unlockArmed = true;
  clearTimeout(unlockTimer);
  unlockTimer = setTimeout(() => {
    unlockArmed = false;
  }, 20000);
}

function tryUnlockFromHex() {
  if (!unlockArmed) return false;
  if (hexInput.value.trim() !== UNLOCK_CODE) return false;
  unlockArmed = false;
  clearTimeout(unlockTimer);
  showSettings();
  return true;
}

hexInput.addEventListener("input", () => {
  if (tryUnlockFromHex()) return;
  const painted = paint(hexInput.value.trim(), "input");
  if (!painted && !/^[0-9#]*$/.test(hexInput.value.trim())) {
    pickerStatus.textContent = "Use a 6-digit hex color, like #3B82F6.";
  }
});

for (const slider of [sliderR, sliderG, sliderB]) {
  slider.addEventListener("input", () => {
    paint(rgbToHex(sliderR.value, sliderG.value, sliderB.value), "sliders");
  });
}

copyBtn.addEventListener("click", async () => {
  const hex = applyHex(hexInput.value.trim());
  rememberColor(hex);
  try {
    await navigator.clipboard.writeText(hex);
    pickerStatus.textContent = `Copied ${hex}`;
  } catch {
    pickerStatus.textContent = hex;
  }
});

eyeBtn.addEventListener("click", async () => {
  if (!window.EyeDropper) {
    pickerStatus.textContent = "Screen pick is not available in this browser.";
    return;
  }
  try {
    const result = await new EyeDropper().open();
    const hex = paint(result.sRGBHex);
    if (hex) {
      rememberColor(hex);
      pickerStatus.textContent = `Picked ${hex}`;
    }
  } catch {
    pickerStatus.textContent = "Pick cancelled.";
  }
});

pickerTitle.addEventListener("click", () => {
  const now = Date.now();
  titleClicks.push(now);
  while (titleClicks.length && now - titleClicks[0] > 6000) titleClicks.shift();
  if (titleClicks.length >= 10) {
    titleClicks.length = 0;
    armUnlock();
  }
});

chrome.storage.local.get({ recentColors: ["#3B82F6", "#111827", "#F59E0B", "#10B981", "#EF4444", "#8B5CF6"] }, (stored) => {
  recentColors = Array.isArray(stored.recentColors) ? stored.recentColors : [];
  renderPalette();
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
    senderName: "",
    autoExport: true,
    pollRemote: true,
    lastStatus: "",
  });
  uploadUrlInput.value = stored.uploadUrl;
  tokenInput.value = stored.token;
  senderNameInput.value = stored.senderName;
  autoExportInput.checked = stored.autoExport !== false;
  pollRemoteInput.checked = stored.pollRemote !== false;
  if (stored.lastStatus) setSettingsStatus(stored.lastStatus);
}

saveBtn.addEventListener("click", async () => {
  const uploadUrl = uploadUrlInput.value.trim().replace(/\/$/, "");
  const token = tokenInput.value.trim();
  const senderName = senderNameInput.value.trim();
  if (!uploadUrl || !token || !senderName) {
    setSettingsStatus("Upload URL, token, and sender name are required.", "error");
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
    senderName,
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
  from.setMonth(from.getMonth() - 2);
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
