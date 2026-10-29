# WhatsApp Search Prototype

Links to your WhatsApp as a linked device (like WhatsApp Web), saves the PDFs, photos and
documents from your chats, and lets you search them by filename, caption or the text inside.

- **PDFs:** text is extracted; scanned PDFs are read with OCR (first 5 pages).
- **Photos:** text in the image is read with OCR, so a photo of a receipt is searchable.
- **Other documents** (Word, Excel, etc.): saved and searchable by filename and caption.
- **History:** on first link, WhatsApp sends your chat history and old files are indexed too.

## Setup

```bash
npm install
npm start
```

Scan the QR code with WhatsApp > Settings > Linked Devices > Link a device. Leave it
running: history arrives in batches and can take a while for big accounts.

## Search

```bash
npm run search receipt
```

Each match shows the filename, where the word was found, the chat, the date, the full path
of the saved file and a snippet of the matching text.

## Re-importing history

WhatsApp only sends history when a device is first linked. To pull it again:

1. Stop the program.
2. On your phone, unlink the old device in Linked Devices.
3. Delete the `whatsapp-auth` folder.
4. Run `npm start` and scan the new QR code.

Files already indexed are skipped, so nothing is duplicated.

## Limits

- Very old media may no longer be on WhatsApp's servers. The program asks your phone to
  re-upload it, which only works if your phone is online and still has the file.
- Files over 25 MB are skipped.
- Baileys is an unofficial WhatsApp client and goes against WhatsApp's terms of service,
  so an account using it can be restricted. Use it on your own account at your own risk.
