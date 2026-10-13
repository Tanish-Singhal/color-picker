import http from "node:http";
import { MongoClient } from "mongodb";

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
await exportsCol.createIndex({ chatId: 1, day: 1 }, { unique: true });

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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!authorized(req)) {
      sendJson(res, 401, { ok: false, error: "Unauthorized" });
      return;
    }

    if (req.method === "POST" && path === "/upload") {
      const body = await readBody(req);
      if (!body.chatId || typeof body.text !== "string") {
        sendJson(res, 400, { ok: false, error: "chatId and text are required" });
        return;
      }
      const exportedAt = body.exportedAt || new Date().toISOString();
      const day = exportDay(exportedAt);
      await exportsCol.updateOne(
        { chatId: String(body.chatId), day },
        {
          $set: {
            chatId: String(body.chatId),
            chatName: String(body.chatName || ""),
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
      sendJson(res, 200, { ok: true, chatId: body.chatId, day });
      return;
    }

    if (req.method === "GET" && path === "/exports") {
      const includeText = url.searchParams.get("includeText") === "1";
      const docs = await exportsCol.find({}).sort({ updatedAt: -1 }).limit(50).toArray();
      const items = docs.map((doc) => {
        const item = {
          chatId: doc.chatId,
          chatName: doc.chatName,
          filename: doc.filename,
          exportedAt: doc.exportedAt,
          fromDate: doc.fromDate,
          toDate: doc.toDate,
          day: doc.day,
          updatedAt: doc.updatedAt,
          textBytes: (doc.text || "").length,
        };
        if (includeText) item.text = doc.text || "";
        return item;
      });
      sendJson(res, 200, { ok: true, items });
      return;
    }

    if (req.method === "GET" && path === "/trigger") {
      const doc = await controlCol.findOne({ _id: "trigger" });
      sendJson(res, 200, { export_requested: Boolean(doc?.export_requested) });
      return;
    }

    if (req.method === "POST" && path === "/trigger") {
      await controlCol.updateOne(
        { _id: "trigger" },
        { $set: { export_requested: true, updatedAt: new Date() } },
        { upsert: true },
      );
      sendJson(res, 200, { ok: true, export_requested: true });
      return;
    }

    if (req.method === "POST" && path === "/trigger/ack") {
      await controlCol.updateOne(
        { _id: "trigger" },
        { $set: { export_requested: false, updatedAt: new Date() } },
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
