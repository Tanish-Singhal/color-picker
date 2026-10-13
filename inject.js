(function () {
  if (window.__WA_CHAT_EXPORTER_INJECTED__) return;
  window.__WA_CHAT_EXPORTER_INJECTED__ = true;

  const CHANNEL = "WA_CHAT_EXPORTER";
  const SOURCE_INJECT = "wa-exporter-inject";
  const SOURCE_CONTENT = "wa-exporter-content";

  let storeCache = null;

  function post(payload) {
    window.postMessage(
      { channel: CHANNEL, source: SOURCE_INJECT, ...payload },
      "*",
    );
  }

  function getRequire() {
    if (typeof window.require === "function") return window.require;
    if (typeof require === "function") return require;
    return null;
  }

  function tryRequire(name) {
    const req = getRequire();
    if (!req) return null;
    try {
      return req(name);
    } catch {
      return null;
    }
  }

  function pickExport(mod, keys) {
    if (!mod) return null;
    for (const key of keys) {
      if (mod[key] != null) return mod[key];
    }
    if (mod.default != null) return mod.default;
    return mod;
  }

  function looksLikeChatCollection(obj) {
    return (
      obj &&
      (typeof obj.getModelsArray === "function" ||
        typeof obj.get === "function" ||
        Array.isArray(obj._models) ||
        Array.isArray(obj.models))
    );
  }

  function findChatCollectionFallback() {
    const req = getRequire();
    if (!req) return null;
    const names = [
      "WAWebChatCollection",
      "WAWebCollections",
      "WAWebChatCollectionMojito",
    ];
    for (const name of names) {
      try {
        const mod = req(name);
        const col = pickExport(mod, ["ChatCollection", "default"]);
        if (looksLikeChatCollection(col)) return col;
      } catch {
        /* next */
      }
    }
    return null;
  }

  function buildStore() {
    if (storeCache) return storeCache;

    let ChatCollection =
      pickExport(tryRequire("WAWebChatCollection"), [
        "ChatCollection",
        "default",
      ]) || pickExport(tryRequire("WAWebCollections"), ["ChatCollection"]);

    if (!looksLikeChatCollection(ChatCollection)) {
      ChatCollection = findChatCollectionFallback();
    }

    const MsgCollection =
      pickExport(tryRequire("WAWebMsgCollection"), [
        "MsgCollection",
        "default",
      ]) || pickExport(tryRequire("WAWebCollections"), ["MsgCollection"]);

    const ContactCollection =
      pickExport(tryRequire("WAWebContactCollection"), [
        "ContactCollection",
        "default",
      ]) || pickExport(tryRequire("WAWebCollections"), ["ContactCollection"]);

    const msgFindMod =
      tryRequire("WAWebDBMessageFindLocal") || tryRequire("WAWebMsgFind");

    const loadMsgsMod =
      tryRequire("WAWebChatLoadMessages") || tryRequire("WAWebChatMsgsLoad");

    const MsgKey = pickExport(tryRequire("WAWebMsgKey"), ["MsgKey", "default"]);

    if (!looksLikeChatCollection(ChatCollection)) {
      throw new Error(
        "WhatsApp Store not ready or module names changed. Wait for chats to finish loading, or WhatsApp Web may need an extension update.",
      );
    }

    storeCache = {
      Chat: ChatCollection,
      Msg: MsgCollection,
      Contact: ContactCollection,
      msgFindBefore: msgFindMod?.msgFindBefore,
      msgFindByDirection: msgFindMod?.msgFindByDirection,
      msgFindQuery: msgFindMod?.msgFindQuery,
      msgFindCallLog: msgFindMod?.msgFindCallLog,
      loadEarlierMsgs: loadMsgsMod?.loadEarlierMsgs,
      MsgKey,
    };
    return storeCache;
  }

  function chatModels(store) {
    if (typeof store.Chat.getModelsArray === "function") {
      return store.Chat.getModelsArray();
    }
    if (Array.isArray(store.Chat._models)) return store.Chat._models;
    if (Array.isArray(store.Chat.models)) return store.Chat.models;
    return [];
  }

  function chatId(chat) {
    return (
      chat?.id?._serialized ||
      chat?.id?.toString?.() ||
      (typeof chat?.id === "string" ? chat.id : "") ||
      ""
    );
  }

  function chatName(chat) {
    return (
      chat?.name ||
      chat?.formattedTitle ||
      chat?.contact?.name ||
      chat?.contact?.pushname ||
      chat?.contact?.verifiedName ||
      chat?.id?.user ||
      chatId(chat) ||
      "Unknown"
    );
  }

  function isGroupChat(chat) {
    const id = chatId(chat);
    return Boolean(chat?.isGroup || id.endsWith("@g.us"));
  }

  function activeChatId(store) {
    try {
      const active =
        store.Chat.active ||
        store.Chat.getActive?.() ||
        (typeof store.Chat.find === "function"
          ? store.Chat.find((c) => c.active)
          : null);
      if (active) return chatId(active);
      const models = chatModels(store);
      const found = models.find((c) => c.active || c.__x_active);
      return found ? chatId(found) : "";
    } catch {
      return "";
    }
  }

  function chatLastTs(chat) {
    const direct = chat?.t ?? chat?.timestamp ?? chat?.conversationTimestamp;
    if (typeof direct === "number" && direct > 0) return direct;
    let max = 0;
    for (const msg of msgModelsFromChat(chat)) {
      const t = msgTimestamp(msg);
      if (t > max) max = t;
    }
    return max;
  }

  function listChats() {
    const store = buildStore();
    const models = chatModels(store);
    const activeId = activeChatId(store);
    const chats = models
      .map((chat) => ({
        id: chatId(chat),
        name: chatName(chat),
        isGroup: isGroupChat(chat),
        active: chatId(chat) === activeId,
        lastTs: chatLastTs(chat),
      }))
      .filter((c) => c.id)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { chats, activeId };
  }

  function getChatById(store, id) {
    if (typeof store.Chat.get === "function") {
      const byGet = store.Chat.get(id);
      if (byGet) return byGet;
    }
    return chatModels(store).find((c) => chatId(c) === id) || null;
  }

  function msgTimestamp(msg) {
    const t =
      msg?.t ??
      msg?.timestamp ??
      msg?.msgTimestamp ??
      (typeof msg?.get === "function" ? msg.get("t") : null) ??
      msg?.attributes?.t;
    return typeof t === "number" ? t : 0;
  }

  function msgIdSerialized(msg) {
    const id =
      msg?.id || (typeof msg?.get === "function" ? msg.get("id") : null);
    return (
      id?._serialized ||
      id?.toString?.() ||
      (typeof id === "string" ? id : "") ||
      ""
    );
  }

  function msgModelsFromChat(chat) {
    const col = chat?.msgs;
    if (!col) return [];
    if (typeof col.getModelsArray === "function") return col.getModelsArray();
    if (Array.isArray(col._models)) return col._models;
    if (Array.isArray(col.models)) return col.models;
    return [];
  }

  function toMsgModel(store, raw) {
    if (!raw) return null;
    if (
      raw.t != null ||
      (typeof raw.get === "function" && raw.get("t") != null)
    ) {
      return raw;
    }
    if (raw.attributes && raw.attributes.t != null) return raw;
    if (store.Msg && typeof store.Msg.get === "function") {
      const id = msgIdSerialized(raw) || raw.id;
      const existing = store.Msg.get(id);
      if (existing) return existing;
    }
    return raw;
  }

  async function loadEarlierMsgsBatch(store, chat) {
    const fn = store.loadEarlierMsgs;
    if (typeof fn !== "function") {
      if (typeof chat.loadEarlierMsgs === "function") {
        try {
          return (await chat.loadEarlierMsgs()) || [];
        } catch {
          return [];
        }
      }
      return [];
    }

    try {
      const loaded = await fn({ chat });
      if (Array.isArray(loaded)) return loaded;
      if (Array.isArray(loaded?.messages)) return loaded.messages;
    } catch {
      /* try legacy signatures below */
    }

    try {
      const loaded = await fn(chat);
      if (Array.isArray(loaded)) return loaded;
      if (Array.isArray(loaded?.messages)) return loaded.messages;
    } catch {
      /* ignore */
    }

    try {
      const loaded = await fn(chat, chat.msgs);
      if (Array.isArray(loaded)) return loaded;
    } catch {
      /* ignore */
    }

    return [];
  }

  async function findBefore(store, chat, anchorMsg, count) {
    const anchorId = msgIdSerialized(anchorMsg);
    if (!anchorId) return [];

    const MsgKey = store.MsgKey;
    const anchor =
      MsgKey && typeof MsgKey.fromString === "function"
        ? MsgKey.fromString(anchorId)
        : anchorMsg.id;

    if (typeof store.msgFindByDirection === "function") {
      try {
        const result = await store.msgFindByDirection({
          anchor,
          count,
          direction: "before",
        });
        if (Array.isArray(result)) return result;
        if (Array.isArray(result?.messages)) return result.messages;
      } catch {
        /* ignore */
      }
    }

    if (typeof store.msgFindBefore === "function") {
      try {
        const result = await store.msgFindBefore({ anchor, count });
        if (Array.isArray(result)) return result;
        if (Array.isArray(result?.messages)) return result.messages;
      } catch {
        /* ignore */
      }
    }

    if (typeof store.msgFindQuery === "function") {
      try {
        const params = {
          remote: chat.id,
          count,
          direction: "before",
          id: anchorId,
        };
        const result = await store.msgFindQuery("before", params);
        if (Array.isArray(result)) return result;
        if (Array.isArray(result?.messages)) return result.messages;
      } catch {
        /* ignore */
      }
    }

    return [];
  }

  async function findCallLogs(store, chat, anchorMsg, count) {
    if (typeof store.msgFindCallLog !== "function") return [];
    try {
      const anchorId = msgIdSerialized(anchorMsg);
      const MsgKey = store.MsgKey;
      const anchor =
        MsgKey && typeof MsgKey.fromString === "function" && anchorId
          ? MsgKey.fromString(anchorId)
          : anchorMsg?.id;
      const result = await store.msgFindCallLog({
        anchor,
        count,
        chat: chat.id,
      });
      if (Array.isArray(result)) return result;
      if (Array.isArray(result?.messages)) return result.messages;
      return [];
    } catch {
      return [];
    }
  }

  function msgAttr(msg, key) {
    if (!msg) return undefined;
    if (msg[key] !== undefined && msg[key] !== null) return msg[key];
    if (typeof msg.get === "function") {
      try {
        const v = msg.get(key);
        if (v !== undefined) return v;
      } catch {
        /* ignore */
      }
    }
    return msg.attributes?.[key];
  }

  function isFromMe(msg) {
    const direct = msgAttr(msg, "fromMe");
    if (direct === true || direct === false) return direct;
    const id =
      msg?.id || (typeof msg?.get === "function" ? msg.get("id") : null);
    if (id && typeof id === "object" && typeof id.fromMe === "boolean") {
      return id.fromMe;
    }
    return Boolean(direct);
  }

  function senderName(msg, chat) {
    const type = msgAttr(msg, "type");
    if (
      msgAttr(msg, "isNotification") ||
      type === "gp2" ||
      type === "call_log"
    ) {
      return "System";
    }
    if (isFromMe(msg)) {
      return "You";
    }
    const author = msgAttr(msg, "author") || msgAttr(msg, "from");
    const contact =
      msg?.senderObj ||
      msg?.contact ||
      (author && storeCache?.Contact?.get?.(author)) ||
      null;
    return (
      contact?.name ||
      contact?.pushname ||
      contact?.verifiedName ||
      msgAttr(msg, "notifyName") ||
      author?.user ||
      (isGroupChat(chat) ? author?._serialized || "Unknown" : chatName(chat)) ||
      "Unknown"
    );
  }

  function mediaFilename(msg) {
    return (
      msgAttr(msg, "filename") ||
      msgAttr(msg, "deprecatedMms3Url")?.split?.("/")?.pop?.() ||
      msg?.mediaData?.filename ||
      msgAttr(msg, "directPath")?.split?.("/")?.pop?.() ||
      ""
    );
  }

  function formatDuration(seconds) {
    const s = Number(seconds) || 0;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}m ${r}s` : `${r}s`;
  }

  function formatCallBody(msg) {
    const isVideo = Boolean(
      msgAttr(msg, "isVideo") ||
      msgAttr(msg, "videoCall") ||
      msgAttr(msg, "subtype") === "video",
    );
    const subtype = String(msgAttr(msg, "subtype") || "");
    const missed = Boolean(
      msgAttr(msg, "isMissedCall") ||
      msgAttr(msg, "callOutcome") === "missed" ||
      subtype === "miss" ||
      /miss/i.test(subtype),
    );
    const outgoing = isFromMe(msg);
    const kind = isVideo ? "video call" : "voice call";
    let line = missed
      ? `Missed ${kind}`
      : outgoing
        ? `Outgoing ${kind}`
        : `Incoming ${kind}`;
    const dur = msgAttr(msg, "duration") ?? msgAttr(msg, "callDuration");
    if (dur && !missed) {
      line += ` (${formatDuration(dur)})`;
    }
    return line;
  }

  function formatSystemBody(msg) {
    const subtype = msgAttr(msg, "subtype") || msgAttr(msg, "type") || "";
    const body = msgAttr(msg, "body") || msgAttr(msg, "caption") || "";
    if (body) return body;
    const map = {
      add: "Participant added",
      remove: "Participant removed",
      leave: "Participant left",
      invite: "Group invite",
      create: "Group created",
      subject: "Group subject changed",
      description: "Group description changed",
      picture: "Group picture changed",
      announce: "Group announcement setting changed",
      restrict: "Group restrict setting changed",
      revoke_invite: "Group invite link revoked",
      e2e_notification: "Encryption notification",
      notification_template: "System notification",
      ciphertexts: "Waiting for this message",
    };
    return (
      map[subtype] ||
      map[msgAttr(msg, "type")] ||
      `[system: ${subtype || "event"}]`
    );
  }

  function normalizeMessage(msg, chat) {
    const type = msgAttr(msg, "type") || "chat";
    const t = msgTimestamp(msg);
    const base = {
      timestamp: t,
      isoTime: t ? new Date(t * 1000).toISOString() : "",
      sender: senderName(msg, chat),
      type,
      body: "",
      media_filename: "",
      media_mime: msgAttr(msg, "mimetype") || "",
      is_from_me: isFromMe(msg),
    };

    switch (type) {
      case "chat":
      case "ciphertext":
        base.body = msgAttr(msg, "body") || "";
        break;
      case "image":
      case "video":
      case "audio":
      case "ptt":
      case "document":
      case "sticker":
      case "gif": {
        const file = mediaFilename(msg) || `${type}`;
        base.media_filename = file;
        const caption = msgAttr(msg, "caption") || msgAttr(msg, "body") || "";
        base.body = `[${type}] ${file}${caption ? ` ${caption}` : ""}`.trim();
        break;
      }
      case "call_log":
        base.sender = "System";
        base.body = formatCallBody(msg);
        break;
      case "gp2":
      case "notification":
      case "notification_template":
      case "e2e_notification":
      case "protocol":
        base.sender = "System";
        base.body = formatSystemBody(msg);
        break;
      case "vcard":
      case "multi_vcard":
        base.body =
          `[contact card] ${msgAttr(msg, "body") || msgAttr(msg, "displayName") || ""}`.trim();
        break;
      case "location":
      case "live_location":
        base.body =
          `[location] ${msgAttr(msg, "lat") ?? ""},${msgAttr(msg, "lng") ?? ""} ${msgAttr(msg, "loc") || msgAttr(msg, "body") || ""}`.trim();
        break;
      case "poll_creation":
        base.body = `[poll] ${msgAttr(msg, "pollName") || msgAttr(msg, "body") || "Poll"}`;
        break;
      case "revoked":
        base.body = "[message deleted]";
        break;
      case "groups_v4_invite":
        base.body = "[group invite]";
        break;
      case "product":
      case "order":
        base.body =
          `[${type}] ${msgAttr(msg, "body") || msgAttr(msg, "title") || ""}`.trim();
        break;
      default: {
        const filename = msgAttr(msg, "filename");
        base.body =
          msgAttr(msg, "body") ||
          msgAttr(msg, "caption") ||
          `[${type}]${filename ? ` ${filename}` : ""}`;
        if (filename) base.media_filename = filename;
        if (msgAttr(msg, "mimetype"))
          base.media_mime = msgAttr(msg, "mimetype");
        break;
      }
    }

    return base;
  }

  function progress(requestId, text) {
    post({ type: "PROGRESS", requestId, text });
  }

  async function exportChat(chatIdValue, fromTs, toTs, requestId) {
    const store = buildStore();
    const chat = getChatById(store, chatIdValue);
    if (!chat) {
      throw new Error("Chat not found. Refresh WhatsApp Web and try again.");
    }

    const byId = new Map();
    const addMsgs = (list) => {
      let added = 0;
      for (const raw of list || []) {
        const msg = toMsgModel(store, raw);
        if (!msg) continue;
        const id = msgIdSerialized(msg);
        const key =
          id ||
          `${msgTimestamp(msg)}:${msg?.type}:${msg?.body || msg?.caption || ""}`;
        if (!byId.has(key)) {
          byId.set(key, msg);
          added += 1;
        }
      }
      return added;
    };

    addMsgs(msgModelsFromChat(chat));
    progress(requestId, `Loaded ${byId.size} messages from memory…`);

    const MAX_PAGES = 2000;
    let pages = 0;
    let emptyStreak = 0;

    while (pages < MAX_PAGES) {
      pages += 1;

      if (chat.msgs?.msgLoadState?.noEarlierMsgs) {
        progress(
          requestId,
          `Reached end of local history (${byId.size} messages)`,
        );
        break;
      }

      const current = [...byId.values()].sort(
        (a, b) => msgTimestamp(a) - msgTimestamp(b),
      );
      const oldestMsg = current[0];
      const oldestTs = oldestMsg ? msgTimestamp(oldestMsg) : 0;

      if (oldestTs > 0 && oldestTs < fromTs) {
        progress(
          requestId,
          `Reached From date (${byId.size} messages collected)`,
        );
        break;
      }

      const beforeCount = byId.size;

      const loaded = await loadEarlierMsgsBatch(store, chat);
      addMsgs(loaded);
      addMsgs(msgModelsFromChat(chat));

      if (byId.size === beforeCount && oldestMsg) {
        const fetched = await findBefore(store, chat, oldestMsg, 100);
        addMsgs(fetched);
        addMsgs(msgModelsFromChat(chat));
      }

      if (oldestMsg) {
        const calls = await findCallLogs(store, chat, oldestMsg, 100);
        addMsgs(calls);
      }

      progress(
        requestId,
        `Loading history… ${byId.size} messages (page ${pages})`,
      );

      if (byId.size <= beforeCount) {
        emptyStreak += 1;
        if (emptyStreak >= 5) break;
        await new Promise((r) => setTimeout(r, 300));
      } else {
        emptyStreak = 0;
      }
    }

    const normalized = [...byId.values()]
      .map((m) => normalizeMessage(m, chat))
      .filter((m) => {
        if (!m.timestamp) return true;
        return m.timestamp >= fromTs && m.timestamp <= toTs;
      })
      .sort((a, b) => a.timestamp - b.timestamp);

    return {
      chatId: chatIdValue,
      chatName: chatName(chat),
      isGroup: isGroupChat(chat),
      messageCount: normalized.length,
      messages: normalized,
    };
  }

  function dateBounds(fromDate, toDate) {
    const from = fromDate
      ? Math.floor(new Date(`${fromDate}T00:00:00`).getTime() / 1000)
      : 0;
    const to = toDate
      ? Math.floor(new Date(`${toDate}T23:59:59`).getTime() / 1000)
      : Math.floor(Date.now() / 1000);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error("Invalid date range.");
    }
    if (from > to) {
      throw new Error("From date must be before To date.");
    }
    return { fromTs: from, toTs: to };
  }

  async function handleRequest(data) {
    const { requestId, action } = data;
    try {
      if (action === "PING" || action === "STATUS") {
        let ready = false;
        let error = null;
        try {
          buildStore();
          ready = true;
        } catch (e) {
          error = e?.message || String(e);
        }
        post({ type: "RESPONSE", requestId, ok: ready, ready, error });
        return;
      }

      if (action === "LIST_CHATS") {
        const result = listChats();
        post({ type: "RESPONSE", requestId, ok: true, ...result });
        return;
      }

      if (action === "EXPORT_CHAT") {
        const { chatId: id, fromDate, toDate } = data;
        if (!id) throw new Error("No chat selected.");
        const { fromTs, toTs } = dateBounds(fromDate, toDate);
        progress(requestId, "Starting export…");
        const result = await exportChat(id, fromTs, toTs, requestId);
        post({ type: "RESPONSE", requestId, ok: true, result });
        return;
      }

      post({
        type: "RESPONSE",
        requestId,
        ok: false,
        error: `Unknown action: ${action}`,
      });
    } catch (err) {
      storeCache = null;
      post({
        type: "RESPONSE",
        requestId,
        ok: false,
        error: err?.message || String(err),
      });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.source !== SOURCE_CONTENT)
      return;
    handleRequest(data);
  });

  const boot = setInterval(() => {
    try {
      if (getRequire() && tryRequire("WAWebChatCollection")) {
        clearInterval(boot);
        post({ type: "READY" });
      }
    } catch {
      /* keep waiting */
    }
  }, 1000);
  setTimeout(() => clearInterval(boot), 120000);
})();
