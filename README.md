# Eternal Data Excel

Chrome extension that exports a single WhatsApp Web chat to **CSV + TXT** at the same time. Media is **not** downloaded — only filename / mime / caption references are written.

Uses **local WhatsApp Web history only** (whatever is already synced to the linked device). It does not pull full archives from your phone. Export does **not** switch the WhatsApp Web UI to the selected chat.

## Install (unpacked)

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder: `extractor` (the one that contains `manifest.json`)
5. Open [https://web.whatsapp.com](https://web.whatsapp.com) and wait until your chat list is fully loaded
6. Click the extension icon on that tab

## Use

1. Choose a chat from the dropdown (active chat is preselected when possible)
2. Set **From** / **To** (defaults: `2001-01-01` → today)
3. Click **Download**
4. Two files are saved, e.g. `Alice_2026-07-20.csv` and `Alice_2026-07-20.txt`

### TXT format

```text
[20/07/2026, 22:10:05] You: Hello
[20/07/2026, 22:11:02] Alice: [image] IMG-2026.jpg Caption here
[20/07/2026, 22:12:00] System: Missed voice call
```

### CSV columns

`timestamp,iso_time,sender,type,body,media_filename,media_mime,is_from_me`

## Manual test checklist

Run these on a real logged-in WhatsApp Web session after loading the unpacked extension.

### Setup

- [ ] Extension loads without errors on `chrome://extensions`
- [ ] Popup opens on `web.whatsapp.com`
- [ ] Status shows “Ready — N chats” after chats load
- [ ] Popup shows a clear error if opened on a non–WhatsApp tab

### DM export

- [ ] Select a one-to-one chat
- [ ] Export with default date range
- [ ] Both `.csv` and `.txt` download
- [ ] Text messages appear with correct sender (“You” / contact name)
- [ ] Image / video / document / voice rows use `[type] filename` and are not binary media files
- [ ] Call rows appear as System call lines when call history exists locally
- [ ] Narrow date range reduces row count as expected

### Group export

- [ ] Select a group chat (label shows “(group)”)
- [ ] Sender names resolve for other participants when available
- [ ] System / group events (add/remove/subject) appear when present in local history

### Edge cases

- [ ] Empty range (future dates) downloads files with header / zero messages or empty body as appropriate
- [ ] Invalid From > To is blocked in the UI
- [ ] Long history shows progress (“Loading history…”) then completes
- [ ] After a WhatsApp Web update, if Store modules break, status shows a clear “Store not ready / needs update” style error

## Limits

- Completeness = what WhatsApp Web already has for that chat — not a guaranteed phone archive since 2001
- WhatsApp Web updates can rename internal modules; the injector may need maintenance
- No HTML export, no media file download, no multi-chat bulk export, no “get from mobile” sync

## Project files

| File | Role |
|------|------|
| `manifest.json` | MV3 extension config |
| `popup.html` / `popup.css` / `popup.js` | UI |
| `background.js` | Ensures content scripts on the active WA tab |
| `content.js` | Bridge + CSV/TXT builders + downloads |
| `inject.js` | MAIN-world WhatsApp Store access |
| `icons/` | Extension icons |
