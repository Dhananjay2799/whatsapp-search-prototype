# Find — personal unified search

This extends the working `codex/message-search` prototype. It preserves the existing WhatsApp index and Tailscale route, and adds authenticated search, folder imports, and optional Google/Microsoft email connections.

## Run on Windows

From the existing project folder, stop the old search server and connector, then:

```powershell
git pull
npm.cmd install
Copy-Item .env.example .env
```

Only copy `.env.example` if `.env` does not already exist. Edit `.env` in a local editor; keep its values private. For the existing Tailscale setup, set `TAILSCALE_HOST` to your computer's exact `.ts.net` hostname, without `https://` or a trailing slash. Alternatively set it in the same PowerShell window:

```powershell
$env:TAILSCALE_HOST = ((& "C:\Program Files\Tailscale\tailscale.exe" status --json | ConvertFrom-Json).Self.DNSName).TrimEnd('.')
npm.cmd run dev
```

`npm run dev` starts both the search server and WhatsApp connector with text indexing enabled by default. Ctrl+C stops both. The server prints a personal access key. Enter that key on the computer or iPhone search page. Sessions last 12 hours and expire when the server restarts. The key persists locally in `.private/login.json`. To rotate it, stop the server, delete that file, and restart. Do not publish this key.

Tailscale Serve remains a separate service. If it is not running, open another PowerShell window:

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" serve 3000
```

Use its HTTPS address on your iPhone with Tailscale connected. Do not enable Funnel or expose port 3000 publicly. The computer must remain online; server hosting without a laptop is not implemented.

To run the components independently, use `npm start` and `npm run connector` in separate windows.

## Import files and folders

```powershell
npm.cmd run import -- "C:\Users\dhana\OneDrive\Desktop\Documents"
npm.cmd run import -- "C:\path\resume.pdf" "C:\path\resume.docx"
```

Supports UTF-8 TXT/MD/CSV/JSON/LOG, text PDFs, DOCX, XLSX (20 MB per file). Recurses into explicitly selected folders; skips symlinks, application secrets, and index directories. Search matches names, original paths, and extracted text. Results show the full source path. Local files are not downloaded through the phone interface. Reimport to refresh changed files; deleting an original does not automatically remove its indexed copy. Existing `import-text.mjs` still works.

New WhatsApp documents of these supported types are extracted too. Other document attachment names remain searchable with a content-unavailable label. Existing indexed PDFs continue to open through authenticated routes. No complete WhatsApp history or catch-up guarantee; the existing 24-hour catch-up bound remains. Message edits/deletes and disappearing-message lifecycle are not reconciled. Images, scanned PDF OCR, voice notes and semantic search are not implemented.

## Connect Gmail

1. In Google Cloud create/select a project and enable Gmail API.
2. Configure Google Auth Platform consent for a personal test app. Add your email as a test user if the app is in Testing.
3. Create an OAuth **Web application** client. Add this exact authorized redirect URI: `http://localhost:3000/auth/gmail/callback`.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`, then restart the search server.
5. Open `http://localhost:3000` on your computer, unlock, and select Connect Gmail. Approve read-only Gmail access.
6. Select Sync latest. Connect additional accounts separately. Testing-mode authorizations can expire and require reconnecting.

Google Docs/Sheets files are not granted or searched by Gmail authorization. Direct Drive access needs a separate connector. Supported files attached to emails are covered.

## Connect Outlook / school / work email

1. Register an application in Microsoft Entra. Choose organizational directories and personal Microsoft accounts if you need all account types.
2. Add a **Web** platform redirect: `http://localhost:3000/auth/outlook/callback`.
3. Add delegated Graph permissions `User.Read`, `Mail.Read`, and `offline_access`. Create a client secret.
4. Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` in `.env`; restart and select Connect Outlook on the computer.
5. Sign in and consent. A school/employer may require admin approval or block the connection.

Use your own app registrations; no credentials are bundled. Account sign-in runs on the computer because redirects use localhost. Search and sync controls work from the paired phone after connection.

## Email coverage and disconnect

Each manual scan processes up to 200 messages, then saves a continuation for **Continue older mail**. Repeat that action to reach older messages. **Sync latest** restarts from the newest page and resets the older-mail continuation. Gmail lists with `includeSpamTrash=true`; Outlook reads the mailbox message collection and resolves the containing folder. Only messages exposed by the provider and account permissions can be indexed; permanently deleted or unavailable items cannot be recovered. Supported attachment contents and unsupported attachment filenames are indexed. Provider errors, skipped attachments, scan timestamps and remaining older pages appear per account.

This is a snapshot index, not an automatic background email watcher. Provider deletions/moves are not reconciled, and cached content may be stale. Disconnect removes that account's local tokens and indexed emails/attachments. It does not revoke provider consent; revoke that separately in your Google/Microsoft connected-app settings if wanted.

Tokens are encrypted with AES-256-GCM and a local key. The key and encrypted token file are on the same computer; this does not protect against someone who controls that computer or its backups. Search indexes are readable local JSON files. Keep `.private/`, `.env`, `whatsapp-auth/`, and `documents/` out of source control and cloud sharing. If this project is inside OneDrive, exclude these directories from synchronization or move the working project outside OneDrive. This is personal prototype security, not a public multi-user service.

## Explicit limits

- iPhone Messages history: unavailable; no automatic integration has been implemented.
- Direct Google Drive, OneDrive and iCloud: not connected. Downloaded copies can be imported.
- OCR, semantic matching, mobile-native apps, hosted always-on operation: pending.
- WhatsApp remains an unofficial linked-device integration.

## Validation

`npm test` checks legacy WhatsApp compatibility, filename/path/Unicode/Gujarati search, DOCX/XLSX extraction, encrypted credential storage, mocked Gmail/Outlook attachment sync and disconnect, and actual HTTP authentication/CSRF/host restrictions. It does not prove real Google/Microsoft sign-in, account policy approval, full mailbox coverage or phone connectivity. Test real sign-in and one non-sensitive attachment per account before relying on those connectors.
