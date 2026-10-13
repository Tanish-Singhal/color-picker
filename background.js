const WA_ORIGIN = "https://web.whatsapp.com";

let jobLock = false;

const DEFAULT_SETTINGS = {
  uploadUrl: "",
  token: "",
  autoExport: true,
  pollRemote: true,
  lastStatus: "",
  lastRunAt: "",
};

async function ensureContentScripts(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "WA_EXPORTER_PING" });
    return true;
  } catch {
    // Content script not injected yet.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["inject.js"],
    world: "MAIN",
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
  return true;
}

function textToDataUrl(text, mime) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function downloadOne(filename, text, mime) {
  const url = textToDataUrl(text, mime);
  return chrome.downloads.download({
    url,
    filename,
    saveAs: false,
    conflictAction: "uniquify",
  });
}

async function saveFiles(files) {
  for (const file of files || []) {
    await downloadOne(
      file.filename,
      file.text || "",
      file.mime || "text/plain;charset=utf-8",
    );
  }
}

function isoDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthRange() {
  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - 1);
  return { fromDate: isoDate(from), toDate: isoDate(to) };
}

async function getSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

async function findWaTab() {
  const tabs = await chrome.tabs.query({ url: `${WA_ORIGIN}/*` });
  return tabs.find((tab) => tab.id) || null;
}

function apiBase(uploadUrl) {
  return String(uploadUrl || "").replace(/\/$/, "");
}

async function apiFetch(settings, path, options = {}) {
  const response = await fetch(`${apiBase(settings.uploadUrl)}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${settings.token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function topTenPeople(chats) {
  return (chats || [])
    .filter(
      (chat) => chat?.id && !chat.isGroup && !String(chat.id).endsWith("@g.us"),
    )
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
    .slice(0, 10);
}

async function runJob(reason) {
  if (jobLock) return { ok: false, skipped: true };
  const settings = await getSettings();
  if (!settings.uploadUrl || !settings.token) {
    await chrome.storage.local.set({
      lastStatus: "Upload URL or token missing.",
    });
    return { ok: false, error: "missing config" };
  }

  jobLock = true;
  try {
    const tab = await findWaTab();
    if (!tab?.id) throw new Error("WhatsApp Web tab is not open.");
    await ensureContentScripts(tab.id);

    const list = await chrome.tabs.sendMessage(tab.id, {
      type: "WA_EXPORTER_LIST_CHATS",
    });
    if (!list?.ok) throw new Error(list?.error || "Could not list chats.");

    const chats = topTenPeople(list.chats);
    if (!chats.length) throw new Error("No person chats found.");

    const { fromDate, toDate } = monthRange();
    let uploaded = 0;
    for (const chat of chats) {
      const exported = await chrome.tabs.sendMessage(tab.id, {
        type: "WA_EXPORTER_EXPORT_TEXT",
        chatId: chat.id,
        fromDate,
        toDate,
        silent: true,
      });
      if (!exported?.ok) {
        throw new Error(exported?.error || `Export failed for ${chat.name}`);
      }
      await apiFetch(settings, "/upload", {
        method: "POST",
        body: JSON.stringify({
          chatId: chat.id,
          chatName: exported.chatName || chat.name,
          filename: `${exported.base}.txt`,
          text: exported.text || "",
          exportedAt: new Date().toISOString(),
          fromDate,
          toDate,
        }),
      });
      uploaded += 1;
      await chrome.storage.local.set({
        lastStatus: `Uploaded ${uploaded}/${chats.length}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    await chrome.storage.session.set({ ranThisSession: true });
    if (reason === "remote") {
      await apiFetch(settings, "/trigger/ack", { method: "POST" });
    }
    await chrome.storage.local.set({
      lastStatus: `Uploaded ${uploaded}/${chats.length} chats`,
      lastRunAt: new Date().toISOString(),
    });
    return { ok: true, uploaded };
  } catch (err) {
    await chrome.storage.local.set({ lastStatus: err?.message || String(err) });
    return { ok: false, error: err?.message || String(err) };
  } finally {
    jobLock = false;
  }
}

async function maybeStart() {
  if (jobLock) return;
  const settings = await getSettings();
  if (!settings.uploadUrl || !settings.token) return;
  const tab = await findWaTab();
  if (!tab) return;

  const session = await chrome.storage.session.get({ ranThisSession: false });
  let triggered = false;
  if (settings.pollRemote) {
    try {
      const data = await apiFetch(settings, "/trigger");
      triggered = Boolean(data.export_requested);
    } catch {
      triggered = false;
    }
  }

  if (triggered) {
    await runJob("remote");
    return;
  }
  if (settings.autoExport && !session.ranThisSession) {
    await runJob("session");
  }
}

function ensureAlarm() {
  chrome.alarms.create("poll", { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "poll") maybeStart();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "WA_EXPORTER_SAVE_FILES") {
    saveFiles(message.files)
      .then(() => sendResponse({ ok: true }))
      .catch((err) =>
        sendResponse({ ok: false, error: err?.message || String(err) }),
      );
    return true;
  }

  if (message?.type === "WA_READY") {
    maybeStart()
      .then(() => sendResponse({ ok: true }))
      .catch((err) =>
        sendResponse({ ok: false, error: err?.message || String(err) }),
      );
    return true;
  }

  if (message?.type !== "WA_EXPORTER_ENSURE_SCRIPTS") {
    return;
  }

  (async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id || !tab.url?.startsWith(WA_ORIGIN)) {
      sendResponse({
        ok: false,
        error: "Open https://web.whatsapp.com and stay on that tab.",
      });
      return;
    }
    await ensureContentScripts(tab.id);
    sendResponse({ ok: true, tabId: tab.id });
  })().catch((err) => {
    sendResponse({ ok: false, error: err?.message || String(err) });
  });

  return true;
});
