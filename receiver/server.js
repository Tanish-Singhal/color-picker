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

    if (
      (req.method === "GET" || req.method === "HEAD") &&
      path === "/ping"
    ) {
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
      const senderName = String(url.searchParams.get("senderName") || "").trim();
      if (!senderName) {
        const docs = await rostersCol
          .find({}, { projection: { senderName: 1, chatCount: 1, updatedAt: 1 } })
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
      const senderName = String(url.searchParams.get("senderName") || "").trim();
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
            error: "senderName and months (1, 2, 3, 6, or 12) are required for a single chat",
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
            requestSenderName: "",
            requestChatId: "",
            requestChatName: "",
            requestMonths: 0,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
      sendJson(res, 200, { ok: true, export_requested: true });
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

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err?.message || "Server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`receiver listening on ${PORT}`);
});
