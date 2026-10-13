const WA_ORIGIN = "https://web.whatsapp.com";

const chatSelect = document.getElementById("chatSelect");
const fromDate = document.getElementById("fromDate");
const toDate = document.getElementById("toDate");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.classList.remove("error", "ok");
  if (kind) statusEl.classList.add(kind);
}

function toISODate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function oneMonthAgoDate() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d;
}

fromDate.value = toISODate(oneMonthAgoDate());
toDate.value = toISODate(new Date());

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function getWaTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith(WA_ORIGIN)) {
    throw new Error("Open https://web.whatsapp.com and stay on that tab.");
  }
  return tab;
}

async function ensureReady() {
  const ensured = await chrome.runtime.sendMessage({
    type: "WA_EXPORTER_ENSURE_SCRIPTS",
  });
  if (!ensured?.ok) {
    throw new Error(ensured?.error || "Could not reach WhatsApp Web tab.");
  }
  return ensured.tabId;
}

async function withRetry(fn, attempts = 8, delayMs = 750) {
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

  for (const chat of chats) {
    const opt = document.createElement("option");
    opt.value = chat.id;
    opt.textContent = `${chat.name}${chat.isGroup ? " (group)" : ""}`;
    chatSelect.appendChild(opt);
  }

  if (activeId && chats.some((c) => c.id === activeId)) {
    chatSelect.value = activeId;
  }

  chatSelect.disabled = false;
  downloadBtn.disabled = false;
}

async function loadChats() {
  setStatus("Connecting to WhatsApp Web…");
  downloadBtn.disabled = true;
  chatSelect.disabled = true;

  try {
    const tabId = await ensureReady();
    await getWaTab();

    const status = await withRetry(() =>
      sendToTab(tabId, { type: "WA_EXPORTER_STATUS" }),
    );

    if (!status?.ok || status.ready === false) {
      setStatus(
        status?.error ||
          "WhatsApp is not ready yet. Wait until your chats appear, then reopen this popup.",
        "error",
      );
      return;
    }

    setStatus("Loading chat list…");
    const list = await withRetry(() =>
      sendToTab(tabId, { type: "WA_EXPORTER_LIST_CHATS" }),
    );

    if (!list?.ok) {
      throw new Error(list?.error || "Failed to list chats.");
    }

    fillChats(list.chats || [], list.activeId || "");
    setStatus(
      `Ready — ${list.chats?.length || 0} chats. Local history only.`,
      "ok",
    );
  } catch (err) {
    setStatus(err?.message || String(err), "error");
    chatSelect.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Unavailable";
    chatSelect.appendChild(opt);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "WA_EXPORTER_PROGRESS" && message.text) {
    setStatus(message.text);
  }
});

downloadBtn.addEventListener("click", async () => {
  const chatId = chatSelect.value;
  if (!chatId) {
    setStatus("Select a chat first.", "error");
    return;
  }
  if (!fromDate.value || !toDate.value) {
    setStatus("Set both From and To dates.", "error");
    return;
  }
  if (fromDate.value > toDate.value) {
    setStatus("From date must be before To date.", "error");
    return;
  }

  downloadBtn.disabled = true;
  setStatus("Starting export…");

  try {
    const tabId = await ensureReady();
    const result = await sendToTab(tabId, {
      type: "WA_EXPORTER_EXPORT",
      chatId,
      fromDate: fromDate.value,
      toDate: toDate.value,
    });

    if (!result?.ok) {
      throw new Error(result?.error || "Export failed.");
    }

    setStatus(
      `Downloaded ${result.count} messages as ${result.base}.txt`,
      "ok",
    );
  } catch (err) {
    setStatus(err?.message || String(err), "error");
  } finally {
    downloadBtn.disabled = !chatSelect.value;
  }
});

loadChats();
