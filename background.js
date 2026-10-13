const WA_ORIGIN = "https://web.whatsapp.com";

let jobLock = false;

const DEFAULT_SETTINGS = {
  uploadUrl: "",
  token: "",
  senderName: "",
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

function monthRange(months) {
  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - (Number(months) || 2));
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

async function reportStatus(settings, message) {
  if (!settings?.uploadUrl || !settings?.token) return;
  try {
    await apiFetch(settings, "/sender-status", {
      method: "POST",
      body: JSON.stringify({
        message,
        at: new Date().toISOString(),
        senderName: settings.senderName || "",
      }),
    });
  } catch {
    // The viewer keeps the last status it received.
  }
}

async function sendToWaTab(tabId, message) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw lastError || new Error("WhatsApp tab did not respond.");
}

async function uploadChat(settings, tabId, chat, fromDate, toDate, replaceChat) {
  const exported = await sendToWaTab(tabId, {
    type: "WA_EXPORTER_EXPORT_TEXT",
    chatId: chat.id,
    fromDate,
    toDate,
    silent: true,
  });
  if (!exported?.ok) {
    throw new Error(exported?.error || `Export failed for ${chat.name || chat.id}`);
  }
  await apiFetch(settings, "/upload", {
    method: "POST",
    body: JSON.stringify({
      chatId: chat.id,
      chatName: exported.chatName || chat.name || "",
      senderName: settings.senderName,
      isGroup: Boolean(chat.isGroup),
      filename: `${exported.base}.txt`,
      text: exported.text || "",
      exportedAt: new Date().toISOString(),
      fromDate,
      toDate,
      replaceChat: Boolean(replaceChat),
    }),
  });
  return exported;
}

async function runSingleChatJob(settings, request) {
  if (jobLock) return { ok: false, skipped: true };
  jobLock = true;
  try {
    const tab = await findWaTab();
    if (!tab?.id) throw new Error("WhatsApp Web tab is not open.");
    await ensureContentScripts(tab.id);

    const months = Number(request.requestMonths) || 2;
    const label = request.requestChatName || request.requestChatId;
    await reportStatus(settings, `Fetching ${label} for ${months} month${months === 1 ? "" : "s"}…`);

    const { fromDate, toDate } = monthRange(months);
    await uploadChat(
      settings,
      tab.id,
      {
        id: request.requestChatId,
        name: request.requestChatName || request.requestChatId,
      },
      fromDate,
      toDate,
      true,
    );

    await apiFetch(settings, "/trigger/ack", { method: "POST" });
    const message = `Uploaded ${label} (${months} month${months === 1 ? "" : "s"})`;
    await chrome.storage.local.set({
      lastStatus: message,
      lastRunAt: new Date().toISOString(),
    });
    await reportStatus(settings, message);
    return { ok: true, uploaded: 1 };
  } catch (err) {
    const message = err?.message || String(err);
    await chrome.storage.local.set({ lastStatus: message });
    await reportStatus(settings, message);
    return { ok: false, error: message };
  } finally {
    jobLock = false;
  }
}

async function runRosterJob(reason) {
  if (jobLock) return { ok: false, skipped: true };
  const settings = await getSettings();
  if (!settings.uploadUrl || !settings.token || !settings.senderName) {
    await chrome.storage.local.set({
      lastStatus: "Upload URL, token, and sender name are required.",
    });
    return { ok: false, error: "missing config" };
  }

  jobLock = true;
  try {
    const tab = await findWaTab();
    if (!tab?.id) throw new Error("WhatsApp Web tab is not open.");
    await ensureContentScripts(tab.id);
    await reportStatus(settings, "Syncing people list…");

    const list = await sendToWaTab(tab.id, {
      type: "WA_EXPORTER_LIST_CHATS",
    });
    if (!list?.ok) throw new Error(list?.error || "Could not list chats.");

    const chats = (list.chats || [])
      .filter((chat) => chat?.id)
      .map((chat) => ({
        chatId: chat.id,
        chatName: chat.name || chat.id,
        isGroup: Boolean(chat.isGroup),
        lastTs: Number(chat.lastTs) || 0,
      }));
    if (!chats.length) throw new Error("No chats found.");

    await apiFetch(settings, "/roster", {
      method: "POST",
      body: JSON.stringify({
        senderName: settings.senderName,
        chats,
      }),
    });

    await chrome.storage.session.set({ ranThisSession: true });
    if (reason === "remote") {
      await apiFetch(settings, "/trigger/ack", { method: "POST" });
    }
    const message = `Synced ${chats.length} people`;
    await chrome.storage.local.set({
      lastStatus: message,
      lastRunAt: new Date().toISOString(),
    });
    await reportStatus(settings, message);
    return { ok: true, chatCount: chats.length };
  } catch (err) {
    const message = err?.message || String(err);
    await chrome.storage.local.set({ lastStatus: message });
    await reportStatus(settings, message);
    return { ok: false, error: message };
  } finally {
    jobLock = false;
  }
}

async function maybeStart() {
  if (jobLock) return;
  const settings = await getSettings();
  if (!settings.uploadUrl || !settings.token || !settings.senderName) return;
  const tab = await findWaTab();
  if (!tab) {
    await reportStatus(settings, "WhatsApp Web is not open on the sender.");
    return;
  }

  const session = await chrome.storage.session.get({ ranThisSession: false });
  let trigger = null;
  if (settings.pollRemote) {
    try {
      trigger = await apiFetch(settings, "/trigger");
      if (!trigger.export_requested) {
        await reportStatus(settings, "Sender is connected. No pull is waiting.");
      }
    } catch (err) {
      await chrome.storage.local.set({
        lastStatus: err?.message || "Could not reach the receiver.",
      });
      return;
    }
  }

  if (trigger?.export_requested) {
    if (trigger.requestChatId) {
      if (trigger.requestSenderName !== settings.senderName) {
        await reportStatus(
          settings,
          `Waiting for sender “${trigger.requestSenderName || "?"}”.`,
        );
        return;
      }
      await runSingleChatJob(settings, trigger);
      return;
    }
    await runRosterJob("remote");
    return;
  }
  if (settings.autoExport && !session.ranThisSession) {
    await runRosterJob("session");
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
