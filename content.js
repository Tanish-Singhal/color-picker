(function () {
  if (window.__WA_CHAT_EXPORTER_CONTENT__) return;
  window.__WA_CHAT_EXPORTER_CONTENT__ = true;

  const CHANNEL = "WA_CHAT_EXPORTER";
  const SOURCE_INJECT = "wa-exporter-inject";
  const SOURCE_CONTENT = "wa-exporter-content";

  const pending = new Map();
  let requestSeq = 0;

  function nextRequestId() {
    requestSeq += 1;
    return `req_${Date.now()}_${requestSeq}`;
  }

  function callInject(action, payload = {}, onProgress) {
    const requestId = nextRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(
          new Error(
            "Timed out waiting for WhatsApp Web. Is the page fully loaded?",
          ),
        );
      }, 180000);

      pending.set(requestId, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        onProgress,
      });

      window.postMessage(
        {
          channel: CHANNEL,
          source: SOURCE_CONTENT,
          requestId,
          action,
          ...payload,
        },
        "*",
      );
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.source !== SOURCE_INJECT)
      return;

    if (data.type === "READY") {
      chrome.runtime.sendMessage({ type: "WA_READY" }).catch(() => {});
      return;
    }

    if (data.type === "PROGRESS") {
      const entry = pending.get(data.requestId);
      if (entry?.onProgress) entry.onProgress(data.text || "");
      return;
    }

    if (data.type === "RESPONSE") {
      const entry = pending.get(data.requestId);
      if (!entry) return;
      pending.delete(data.requestId);
      if (data.ok) {
        entry.resolve(data);
      } else {
        entry.reject(new Error(data.error || "Export failed"));
      }
    }
  });

  function formatTxtTimestamp(unixSeconds) {
    if (!unixSeconds) return "[unknown time]";
    const d = new Date(unixSeconds * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `[${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
  }

  function buildTxt(messages) {
    return messages
      .map((m) => {
        const time = formatTxtTimestamp(m.timestamp);
        const sender = m.sender || "Unknown";
        const body = (m.body || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        if (body.includes("\n")) {
          return `${time} ${sender}:\n${body}`;
        }
        return `${time} ${sender}: ${body}`;
      })
      .join("\n");
  }

  function sanitizeFilename(name) {
    return (
      String(name || "chat")
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/\s+/g, "_")
        .slice(0, 80) || "chat"
    );
  }

  function todayStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function downloadViaAnchor(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  function saveFilesInBackground(files) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "WA_EXPORTER_SAVE_FILES", files },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.error || "Download failed"));
            return;
          }
          resolve(response);
        },
      );
    });
  }

  async function downloadTxt(result) {
    const base = `${sanitizeFilename(result.chatName)}_${todayStamp()}`;
    const txt = buildTxt(result.messages || []);
    const files = [
      { filename: `${base}.txt`, text: txt, mime: "text/plain;charset=utf-8" },
    ];

    try {
      await saveFilesInBackground(files);
    } catch {
      for (const file of files) {
        downloadViaAnchor(file.filename, file.text, file.mime);
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    return { base, count: result.messageCount || result.messages?.length || 0 };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === "WA_EXPORTER_PING") {
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "WA_EXPORTER_STATUS") {
      callInject("STATUS")
        .then((data) =>
          sendResponse({
            ok: true,
            ready: data.ready !== false,
            error: data.error,
          }),
        )
        .catch((err) =>
          sendResponse({ ok: false, ready: false, error: err.message }),
        );
      return true;
    }

    if (message.type === "WA_EXPORTER_LIST_CHATS") {
      callInject("LIST_CHATS")
        .then((data) =>
          sendResponse({
            ok: true,
            chats: data.chats || [],
            activeId: data.activeId || "",
          }),
        )
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (
      message.type === "WA_EXPORTER_EXPORT_TEXT" ||
      message.type === "WA_EXPORTER_EXPORT"
    ) {
      const { chatId, fromDate, toDate, silent } = message;
      const uploadOnly = message.type === "WA_EXPORTER_EXPORT_TEXT";
      callInject("EXPORT_CHAT", { chatId, fromDate, toDate }, (text) => {
        if (silent || uploadOnly) return;
        try {
          chrome.runtime.sendMessage({
            type: "WA_EXPORTER_PROGRESS",
            text,
          });
        } catch {
          /* popup may be closed */
        }
      })
        .then(async (data) => {
          const base = `${sanitizeFilename(data.result.chatName)}_${todayStamp()}`;
          const text = buildTxt(data.result.messages || []);
          const count =
            data.result.messageCount || data.result.messages?.length || 0;
          if (uploadOnly) {
            sendResponse({
              ok: true,
              text,
              base,
              count,
              chatName: data.result.chatName,
            });
            return;
          }
          const downloaded = await downloadTxt(data.result);
          sendResponse({
            ok: true,
            count: downloaded.count,
            base: downloaded.base,
            chatName: data.result.chatName,
          });
        })
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  });

  setTimeout(() => {
    callInject("STATUS")
      .then((data) => {
        if (data?.ok || data?.ready) {
          chrome.runtime.sendMessage({ type: "WA_READY" }).catch(() => {});
        }
      })
      .catch(() => {});
  }, 2000);
})();
