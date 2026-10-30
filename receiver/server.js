import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

const pageHtml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "public", "index.html"),
);

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.TOKEN || "";
const MONGODB_URI = process.env.MONGODB_URI || "";
const MAX_BODY = 25 * 1024 * 1024;
const AUTO_FETCH_SENDER = String(
  process.env.AUTO_FETCH_SENDER || "priya2",
).trim();
const AUTO_FETCH_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.AUTO_FETCH_INTERVAL_MS) || 300_000,
);
const AUTO_FETCH_MONTHS = Number(process.env.AUTO_FETCH_MONTHS) || 6;
const AUTO_FETCH_ROSTER_TIMEOUT_MS = 4 * 60 * 1000;
const AUTO_FETCH_CHAT_TIMEOUT_MS = 18 * 60 * 1000;

if (!TOKEN || !MONGODB_URI) {
  console.error("TOKEN and MONGODB_URI are required");
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db();
const exportsCol = db.collection("exports");
const controlCol = db.collection("control");
const rostersCol = db.collection("rosters");
const autoFetchCol = db.collection("autoFetch");
await exportsCol.createIndex(
  { senderName: 1, chatId: 1, day: 1 },
  { unique: true },
);
await rostersCol.createIndex({ senderName: 1 }, { unique: true });
try {
  await exportsCol.dropIndex("chatId_1_day_1");
} catch {
  // Old unique key may already be gone.
}

function authorized(req) {
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function exportDay(value) {
  const iso = value ? new Date(value).toISOString() : new Date().toISOString();
  return iso.slice(0, 10);
}

const ALLOWED_MONTHS = new Set([1, 2, 3, 6, 12]);

function clearTriggerFields() {
  return {
    export_requested: false,
    requestSenderName: "",
    requestChatId: "",
    requestChatName: "",
    requestMonths: 0,
    updatedAt: new Date(),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && path === "/ping") {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : "ok");
      return;
    }

    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageHtml);
      return;
    }

    if (!authorized(req)) {
      sendJson(res, 401, { ok: false, error: "Unauthorized" });
      return;
    }

    if (req.method === "POST" && path === "/upload") {
      const body = await readBody(req);
      const senderName = String(body.senderName || "").trim();
      if (!body.chatId || typeof body.text !== "string" || !senderName) {
        sendJson(res, 400, {
          ok: false,
          error: "chatId, text, and senderName are required",
        });
        return;
      }
      const exportedAt = body.exportedAt || new Date().toISOString();
      const day = exportDay(exportedAt);
      const chatId = String(body.chatId);
      if (body.replaceChat) {
        await exportsCol.deleteMany({ senderName, chatId });
      }
      await exportsCol.updateOne(
        { senderName, chatId, day },
        {
          $set: {
            senderName,
            chatId,
            chatName: String(body.chatName || ""),
            isGroup: Boolean(body.isGroup),
            filename: String(body.filename || ""),
            text: body.text,
            exportedAt,
            fromDate: String(body.fromDate || ""),
            toDate: String(body.toDate || ""),
            day,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
      sendJson(res, 200, { ok: true, senderName, chatId, day });
      return;
    }

    if (req.method === "POST" && path === "/roster") {
      const body = await readBody(req);
      const senderName = String(body.senderName || "").trim();
      if (!senderName || !Array.isArray(body.chats)) {
        sendJson(res, 400, {
          ok: false,
          error: "senderName and chats[] are required",
        });
        return;
      }
      const chats = body.chats
        .map((chat) => ({
          chatId: String(chat.chatId || chat.id || "").trim(),
          chatName: String(chat.chatName || chat.name || "").trim(),
          isGroup: Boolean(chat.isGroup),
          lastTs: Number(chat.lastTs) || 0,
        }))
        .filter((chat) => chat.chatId);
      await rostersCol.updateOne(
        { senderName },
        {
          $set: {
            senderName,
            chats,
            updatedAt: new Date(),
            chatCount: chats.length,
          },
        },
        { upsert: true },
      );
      sendJson(res, 200, { ok: true, senderName, chatCount: chats.length });
      return;
    }

    if (req.method === "GET" && path === "/roster") {
      const senderName = String(
        url.searchParams.get("senderName") || "",
      ).trim();
      if (!senderName) {
        const docs = await rostersCol
          .find(
            {},
            { projection: { senderName: 1, chatCount: 1, updatedAt: 1 } },
          )
          .sort({ senderName: 1 })
          .toArray();
        sendJson(res, 200, {
          ok: true,
          senders: docs.map((doc) => ({
            senderName: doc.senderName,
            chatCount: doc.chatCount || (doc.chats || []).length || 0,
            updatedAt: doc.updatedAt,
          })),
        });
        return;
      }
      const doc = await rostersCol.findOne({ senderName });
      sendJson(res, 200, {
        ok: true,
        senderName,
        chats: doc?.chats || [],
        updatedAt: doc?.updatedAt || null,
      });
      return;
    }

    if (req.method === "GET" && path === "/exports") {
      const includeText = url.searchParams.get("includeText") === "1";
      const senderName = String(
        url.searchParams.get("senderName") || "",
      ).trim();
      const chatId = String(url.searchParams.get("chatId") || "").trim();
      const filter = {};
      if (senderName) filter.senderName = senderName;
      if (chatId) filter.chatId = chatId;
      const allowText = includeText && Boolean(chatId);
      const docs = await exportsCol
        .find(filter)
        .sort({ updatedAt: -1 })
        .limit(chatId ? 20 : 100)
        .toArray();
      const items = docs.map((doc) => {
        const item = {
          senderName: doc.senderName || "",
          chatId: doc.chatId,
          chatName: doc.chatName,
          isGroup: Boolean(doc.isGroup),
          filename: doc.filename,
          exportedAt: doc.exportedAt,
          fromDate: doc.fromDate,
          toDate: doc.toDate,
          day: doc.day,
          updatedAt: doc.updatedAt,
          textBytes: (doc.text || "").length,
        };
        if (allowText) item.text = doc.text || "";
        return item;
      });
      sendJson(res, 200, { ok: true, items });
      return;
    }

    if (req.method === "GET" && path === "/trigger") {
      const doc = await controlCol.findOne({ _id: "trigger" });
      sendJson(res, 200, {
        export_requested: Boolean(doc?.export_requested),
        senderStatus: doc?.senderStatus || "",
        senderAt: doc?.senderAt || "",
        senderName: doc?.senderName || "",
        requestSenderName: doc?.requestSenderName || "",
        requestChatId: doc?.requestChatId || "",
        requestChatName: doc?.requestChatName || "",
        requestMonths: Number(doc?.requestMonths) || 0,
      });
      return;
    }

    if (req.method === "POST" && path === "/sender-status") {
      const body = await readBody(req);
      await controlCol.updateOne(
        { _id: "trigger" },
        {
          $set: {
            senderStatus: String(body.message || ""),
            senderAt: body.at || new Date().toISOString(),
            senderName: String(body.senderName || "").trim(),
          },
        },
        { upsert: true },
      );
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && path === "/trigger") {
      const body = await readBody(req);
      const chatId = String(body.chatId || "").trim();
      const requestSenderName = String(body.senderName || "").trim();
      const requestChatName = String(body.chatName || "").trim();
      const months = Number(body.months) || 0;

      if (chatId) {
        if (!requestSenderName || !ALLOWED_MONTHS.has(months)) {
          sendJson(res, 400, {
            ok: false,
            error:
              "senderName and months (1, 2, 3, 6, or 12) are required for a single chat",
          });
          return;
        }
        await controlCol.updateOne(
          { _id: "trigger" },
          {
            $set: {
              export_requested: true,
              requestSenderName,
              requestChatId: chatId,
              requestChatName,
              requestMonths: months,
              updatedAt: new Date(),
            },
          },
          { upsert: true },
        );
        sendJson(res, 200, {
          ok: true,
          export_requested: true,
          requestSenderName,
          requestChatId: chatId,
          requestChatName,
          requestMonths: months,
        });
        return;
      }

      await controlCol.updateOne(
        { _id: "trigger" },
        {
          $set: {
            export_requested: true,
            requestSenderName,
            requestChatId: "",
            requestChatName: "",
            requestMonths: 0,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
      sendJson(res, 200, {
        ok: true,
        export_requested: true,
        requestSenderName,
      });
      return;
    }

    if (req.method === "POST" && path === "/trigger/ack") {
      await controlCol.updateOne(
        { _id: "trigger" },
        { $set: clearTriggerFields() },
        { upsert: true },
      );
      sendJson(res, 200, { ok: true, export_requested: false });
      return;
    }

    if (req.method === "GET" && path === "/auto-fetch") {
      const senderName = String(
        url.searchParams.get("senderName") || AUTO_FETCH_SENDER || "",
      ).trim();
      const doc = senderName
        ? await autoFetchCol.findOne({ _id: senderName })
        : null;
      sendJson(res, 200, {
        ok: true,
        senderName,
        enabled: Boolean(AUTO_FETCH_SENDER),
        intervalMs: AUTO_FETCH_INTERVAL_MS,
        months: AUTO_FETCH_MONTHS,
        lastCycleAt: doc?.lastCycleAt || null,
        status: doc?.status || "",
        pendingDiffCount: Number(doc?.pendingDiffCount) || 0,
        lastUploaded: Number(doc?.lastUploaded) || 0,
        lastFailed: Number(doc?.lastFailed) || 0,
        updatedAt: doc?.updatedAt || null,
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err?.message || "Server error" });
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStatusChat(chat) {
  const id = String(chat?.chatId || "");
  const name = String(chat?.chatName || "").toLowerCase();
  return id === "status@broadcast" || name === "status";
}

function normalizeTs(value) {
  const n = Number(value) || 0;
  if (!n) return 0;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

async function readTrigger() {
  return (await controlCol.findOne({ _id: "trigger" })) || {};
}

async function setAutoStatus(senderName, fields) {
  await autoFetchCol.updateOne(
    { _id: senderName },
    {
      $set: {
        ...fields,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

async function waitForTriggerClear(timeoutMs, stillOurs, options = {}) {
  const expectedSender = String(options.expectedSender || "").trim();
  const evidence = options.evidence;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(5000);
    const trigger = await readTrigger();
    if (!trigger.export_requested) {
      if (evidence) {
        const proven = await evidence(trigger);
        if (proven) return { ok: true, trigger };
        return { ok: false, aborted: true, trigger };
      }
      return { ok: true, trigger };
    }
    if (stillOurs && !stillOurs(trigger)) {
      return { ok: false, aborted: true, trigger };
    }
    const status = String(trigger.senderStatus || "");
    const statusFromExpected =
      !expectedSender ||
      !trigger.senderName ||
      trigger.senderName === expectedSender;
    if (statusFromExpected && /not open/i.test(status)) {
      return { ok: false, notOpen: true, trigger };
    }
  }
  return { ok: false, timedOut: true, trigger: await readTrigger() };
}

async function queueRosterSync(senderName) {
  await controlCol.updateOne(
    { _id: "trigger" },
    {
      $set: {
        export_requested: true,
        requestSenderName: senderName,
        requestChatId: "",
        requestChatName: "",
        requestMonths: 0,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

async function queueChatFetch(senderName, chat, months) {
  await controlCol.updateOne(
    { _id: "trigger" },
    {
      $set: {
        export_requested: true,
        requestSenderName: senderName,
        requestChatId: chat.chatId,
        requestChatName: chat.chatName || chat.chatId,
        requestMonths: months,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

function diffRosterChats(prevMap, chats) {
  const changed = [];
  for (const chat of chats || []) {
    if (!chat?.chatId || isStatusChat(chat)) continue;
    const prev = normalizeTs(prevMap?.[chat.chatId]);
    const next = normalizeTs(chat.lastTs);
    if (!Object.prototype.hasOwnProperty.call(prevMap || {}, chat.chatId)) {
      changed.push(chat);
      continue;
    }
    if (next > prev) changed.push(chat);
  }
  return changed;
}

function rosterToMap(chats) {
  const map = {};
  for (const chat of chats || []) {
    if (!chat?.chatId || isStatusChat(chat)) continue;
    map[chat.chatId] = normalizeTs(chat.lastTs);
  }
  return map;
}

function progressSnapshotMap(prevMap, chats, succeededIds, unresolvedIds) {
  const map = { ...(prevMap || {}) };
  const succeeded = new Set(succeededIds || []);
  const unresolved = new Set(unresolvedIds || []);
  for (const chat of chats || []) {
    if (!chat?.chatId || isStatusChat(chat)) continue;
    if (unresolved.has(chat.chatId) && !succeeded.has(chat.chatId)) {
      if (!Object.prototype.hasOwnProperty.call(prevMap || {}, chat.chatId)) {
        delete map[chat.chatId];
      }
      continue;
    }
    map[chat.chatId] = normalizeTs(chat.lastTs);
  }
  return map;
}

let autoFetchRunning = false;

async function runAutoFetchCycle(senderName) {
  if (!senderName || autoFetchRunning) return;
  autoFetchRunning = true;
  try {
    const trigger = await readTrigger();
    if (trigger.export_requested) {
      await setAutoStatus(senderName, {
        status: "Skipped: another pull is already waiting.",
        lastCycleAt: new Date().toISOString(),
      });
      return;
    }

    const senderAt = trigger.senderAt || "";
    const senderStatus = String(trigger.senderStatus || "");
    const senderMatches =
      !trigger.senderName || trigger.senderName === senderName;
    if (senderMatches && /not open/i.test(senderStatus) && senderAt) {
      const ageMs = Date.now() - new Date(senderAt).getTime();
      if (!Number.isNaN(ageMs) && ageMs < AUTO_FETCH_INTERVAL_MS * 2) {
        await setAutoStatus(senderName, {
          status: "Skipped: WhatsApp Web is not open on the sender.",
          lastCycleAt: new Date().toISOString(),
        });
        return;
      }
    }

    const beforeRoster = await rostersCol.findOne({ senderName });
    const beforeUpdated = beforeRoster?.updatedAt
      ? new Date(beforeRoster.updatedAt).toISOString()
      : "";
    const snapshot = (await autoFetchCol.findOne({ _id: senderName })) || {};
    const prevMap = snapshot.chats || {};

    await setAutoStatus(senderName, {
      status: `Syncing people for ${senderName}…`,
      lastCycleAt: new Date().toISOString(),
      pendingDiffCount: 0,
    });
    await queueRosterSync(senderName);

    const rosterWait = await waitForTriggerClear(
      AUTO_FETCH_ROSTER_TIMEOUT_MS,
      (t) =>
        Boolean(t.export_requested) &&
        !t.requestChatId &&
        (t.requestSenderName || "") === senderName,
      {
        expectedSender: senderName,
        evidence: async (t) => {
          const rosterDoc = await rostersCol.findOne({ senderName });
          const updated = rosterDoc?.updatedAt
            ? new Date(rosterDoc.updatedAt).toISOString()
            : "";
          if (updated && updated !== beforeUpdated) return true;
          const status = String(t.senderStatus || "");
          return (
            t.senderName === senderName && /Synced\s+\d+\s+people/i.test(status)
          );
        },
      },
    );
    if (rosterWait.aborted) {
      await setAutoStatus(senderName, {
        status: "Aborted: a manual pull replaced the auto roster sync.",
        lastCycleAt: new Date().toISOString(),
      });
      return;
    }
    if (rosterWait.notOpen) {
      if ((await readTrigger()).export_requested) {
        await controlCol.updateOne(
          { _id: "trigger" },
          { $set: clearTriggerFields() },
          { upsert: true },
        );
      }
      await setAutoStatus(senderName, {
        status: "Stopped: WhatsApp Web is not open on the sender.",
        lastCycleAt: new Date().toISOString(),
      });
      return;
    }
    if (rosterWait.timedOut) {
      if ((await readTrigger()).export_requested) {
        await controlCol.updateOne(
          { _id: "trigger" },
          { $set: clearTriggerFields() },
          { upsert: true },
        );
      }
      await setAutoStatus(senderName, {
        status: "Roster sync timed out. Will retry next cycle.",
        lastCycleAt: new Date().toISOString(),
      });
      return;
    }

    const roster = await rostersCol.findOne({ senderName });
    const chats = roster?.chats || [];
    const afterUpdated = roster?.updatedAt
      ? new Date(roster.updatedAt).toISOString()
      : "";
    if (!chats.length) {
      await setAutoStatus(senderName, {
        status: "Roster empty after sync.",
        chats: {},
        lastCycleAt: new Date().toISOString(),
        pendingDiffCount: 0,
      });
      return;
    }

    const firstSnapshot =
      !snapshot.chats || !Object.keys(snapshot.chats).length;
    const changed = firstSnapshot ? [] : diffRosterChats(prevMap, chats);
    const nextMap = rosterToMap(chats);

    if (firstSnapshot) {
      await setAutoStatus(senderName, {
        status: `Baseline saved (${chats.length} people). Next cycle will fetch new activity.`,
        chats: nextMap,
        lastCycleAt: new Date().toISOString(),
        pendingDiffCount: 0,
        lastUploaded: 0,
        lastFailed: 0,
        rosterUpdatedAt: afterUpdated || beforeUpdated,
      });
      return;
    }

    if (!changed.length) {
      await setAutoStatus(senderName, {
        status: `No new chat activity (${chats.length} people).`,
        chats: nextMap,
        lastCycleAt: new Date().toISOString(),
        pendingDiffCount: 0,
        lastUploaded: 0,
        lastFailed: 0,
        rosterUpdatedAt: afterUpdated || beforeUpdated,
      });
      return;
    }

    let uploaded = 0;
    const failed = [];
    const succeededIds = [];
    const unresolvedIds = changed.map((chat) => chat.chatId);
    const snapshotNow = () =>
      progressSnapshotMap(prevMap, chats, succeededIds, unresolvedIds);

    for (let i = 0; i < changed.length; i += 1) {
      const chat = changed[i];
      const label = chat.chatName || chat.chatId;
      const live = await readTrigger();
      if (live.export_requested) {
        await setAutoStatus(senderName, {
          status: `Aborted before “${label}”: another pull is waiting.`,
          chats: snapshotNow(),
          lastCycleAt: new Date().toISOString(),
          pendingDiffCount: changed.length - i,
          lastUploaded: uploaded,
          lastFailed: failed.length,
        });
        return;
      }

      await setAutoStatus(senderName, {
        status: `Fetching ${i + 1}/${changed.length} “${label}” (${AUTO_FETCH_MONTHS} months)…`,
        chats: snapshotNow(),
        lastCycleAt: new Date().toISOString(),
        pendingDiffCount: changed.length - i,
        lastUploaded: uploaded,
        lastFailed: failed.length,
      });

      const beforeExport = await exportsCol.findOne(
        { senderName, chatId: chat.chatId },
        { sort: { updatedAt: -1 } },
      );
      const beforeAt = beforeExport?.exportedAt || "";

      await queueChatFetch(senderName, chat, AUTO_FETCH_MONTHS);
      const chatWait = await waitForTriggerClear(
        AUTO_FETCH_CHAT_TIMEOUT_MS,
        (t) =>
          Boolean(t.export_requested) &&
          t.requestChatId === chat.chatId &&
          (t.requestSenderName || "") === senderName,
        {
          expectedSender: senderName,
          evidence: async (t) => {
            const afterExport = await exportsCol.findOne(
              { senderName, chatId: chat.chatId },
              { sort: { updatedAt: -1 } },
            );
            const afterAt = afterExport?.exportedAt || "";
            if (afterAt && afterAt !== beforeAt) return true;
            const statusText = String(t.senderStatus || "");
            return (
              t.senderName === senderName &&
              statusText.includes("Uploaded") &&
              statusText.includes(label)
            );
          },
        },
      );

      if (chatWait.aborted) {
        await setAutoStatus(senderName, {
          status: `Aborted during “${label}”: a manual pull took over.`,
          chats: snapshotNow(),
          lastCycleAt: new Date().toISOString(),
          pendingDiffCount: changed.length - i,
          lastUploaded: uploaded,
          lastFailed: failed.length,
        });
        return;
      }
      if (chatWait.notOpen) {
        if ((await readTrigger()).export_requested) {
          await controlCol.updateOne(
            { _id: "trigger" },
            { $set: clearTriggerFields() },
            { upsert: true },
          );
        }
        failed.push(label);
        await setAutoStatus(senderName, {
          status: `Stopped on “${label}”: WhatsApp Web is not open.`,
          chats: snapshotNow(),
          lastCycleAt: new Date().toISOString(),
          pendingDiffCount: changed.length - i - 1,
          lastUploaded: uploaded,
          lastFailed: failed.length,
        });
        return;
      }

      if (chatWait.timedOut || !chatWait.ok) {
        if ((await readTrigger()).export_requested) {
          await controlCol.updateOne(
            { _id: "trigger" },
            { $set: clearTriggerFields() },
            { upsert: true },
          );
        }
        failed.push(label);
        continue;
      }
      succeededIds.push(chat.chatId);
      uploaded += 1;
    }

    const failNote = failed.length ? ` Failed: ${failed.join(", ")}.` : "";
    await setAutoStatus(senderName, {
      status: `Done. Uploaded ${uploaded}/${changed.length} updated chats.${failNote}`,
      chats: snapshotNow(),
      lastCycleAt: new Date().toISOString(),
      pendingDiffCount: Math.max(0, changed.length - uploaded),
      lastUploaded: uploaded,
      lastFailed: failed.length,
      rosterUpdatedAt: afterUpdated || beforeUpdated,
    });
  } catch (err) {
    await setAutoStatus(senderName, {
      status: `Auto-fetch error: ${err?.message || String(err)}`,
      lastCycleAt: new Date().toISOString(),
    });
  } finally {
    autoFetchRunning = false;
  }
}

function startAutoFetchLoop() {
  if (!AUTO_FETCH_SENDER) {
    console.log("auto-fetch disabled (AUTO_FETCH_SENDER empty)");
    return;
  }
  if (!ALLOWED_MONTHS.has(AUTO_FETCH_MONTHS)) {
    console.log(
      `auto-fetch disabled (AUTO_FETCH_MONTHS must be 1, 2, 3, 6, or 12; got ${AUTO_FETCH_MONTHS})`,
    );
    return;
  }
  console.log(
    `auto-fetch enabled for ${AUTO_FETCH_SENDER} every ${AUTO_FETCH_INTERVAL_MS}ms (${AUTO_FETCH_MONTHS} months)`,
  );
  const tick = () => {
    runAutoFetchCycle(AUTO_FETCH_SENDER).catch((err) => {
      console.error("auto-fetch cycle failed", err?.message || err);
    });
  };
  setTimeout(tick, 15_000);
  setInterval(tick, AUTO_FETCH_INTERVAL_MS);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`receiver listening on ${PORT}`);
  startAutoFetchLoop();
});
