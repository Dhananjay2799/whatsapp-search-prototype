import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} from 'baileys';
import qrcode from 'qrcode-terminal';
import { PDFParse } from 'pdf-parse';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';

let connectionState = 'connecting';
async function publishStatus() {
  try {
    await writeFile('./.connector-status.json', JSON.stringify({ state: connectionState, updatedAt: Date.now() }), 'utf8');
  } catch (error) { console.error('Status update failed:', error.message); }
}
setInterval(publishStatus, 10000).unref();
publishStatus();

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState('./whatsapp-auth');

  const sock = makeWASocket({
    auth: state,
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (connection) { connectionState = connection === 'open' ? 'connected' : connection === 'close' ? 'disconnected' : 'connecting'; publishStatus(); }
    if (qr) {
      console.log('\nScan the QR code using WhatsApp Linked Devices:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('\nWhatsApp connected successfully.');
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;

      if (status === DisconnectReason.loggedOut) {
        console.log('Logged out. Stop the program and ask for help.');
      } else {
        console.log('Connection closed; retrying in 5 seconds.');
        setTimeout(connect, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ type, messages }) => {
    if (type !== 'notify' && type !== 'append') return;

    for (const item of messages) {
      // Limit catch-up to recent messages; do not silently import full history.
      const timestamp = Number(item.messageTimestamp);
      if (type === 'append' && (!timestamp || timestamp < Date.now() / 1000 - 86400)) continue;
      const message = item.message;
      const document =
        message?.documentMessage ??
        message?.documentWithCaptionMessage?.message?.documentMessage;

      const text = message?.conversation ?? message?.extendedTextMessage?.text;
      if (process.env.INDEX_MESSAGES === '1' && typeof text === 'string' && text.trim()) {
        try {
          await mkdir('./documents', { recursive: true });
          if (!item.key?.id || !item.key?.remoteJid) continue;
          const id = createHash('sha256').update(JSON.stringify([item.key.remoteJid, item.key.id, !!item.key.fromMe, item.key.participant || ''])).digest('hex');
          const record = { type: 'message', filename: 'WhatsApp message', chatId: item.key.remoteJid || 'Unknown', timestamp: Number(item.messageTimestamp) || null, text };
          await writeFile(`./documents/${id}.json`, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
          console.log(type === 'append' ? 'Recent synced text message indexed.' : 'Text message indexed.');
        } catch (error) { if (error.code !== 'EEXIST') console.log('Could not index message:', error.message); }
      }
      if (!document || document.mimetype !== 'application/pdf') continue;
      if (!item.key?.id || !item.key?.remoteJid) continue;

      let parser;

      try {
        console.log('\nPDF detected. Downloading...');
        const id = createHash('sha256').update(JSON.stringify([item.key.remoteJid, item.key.id, !!item.key.fromMe, item.key.participant || ''])).digest('hex');
        await mkdir('./documents', { recursive: true });
        try { await access(`./documents/${id}.json`); continue; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const data = await downloadMediaMessage(item, 'buffer', {});
        await writeFile(`./documents/${id}.pdf`, data);

        parser = new PDFParse({ data: new Uint8Array(data) });
        const result = await parser.getText();

        const record = {
          filename: document.fileName || 'Unnamed PDF',
          chatId: item.key.remoteJid || 'Unknown',
          timestamp: Number(item.messageTimestamp) || null,
          pdfFile: `${id}.pdf`,
          text: result.text || ''
        };

        await writeFile(
          `./documents/${id}.json`,
          JSON.stringify(record, null, 2),
          'utf8'
        );

        console.log(type === 'append' ? 'Recent synced PDF saved and indexed.' : 'PDF saved and indexed.');
        if (!record.text.trim()) {
          console.log('No selectable text found; this PDF may need image recognition.');
        }
      } catch (error) {
        console.log('Could not process PDF:', error.message);
      } finally {
        if (parser) await parser.destroy();
      }
    }
  });
}

connect().catch(error => {
  console.error('Could not start:', error.message);
});