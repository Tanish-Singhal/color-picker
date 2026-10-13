const WA_ORIGIN = "https://web.whatsapp.com";

async function ensureContentScripts(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "WA_EXPORTER_PING" });
    return true;
  } catch {
    //
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
    await downloadOne(file.filename, file.text || "", file.mime || "text/plain;charset=utf-8");
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "WA_EXPORTER_SAVE_FILES") {
    saveFiles(message.files)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message?.type !== "WA_EXPORTER_ENSURE_SCRIPTS") {
    return;
  }

  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
