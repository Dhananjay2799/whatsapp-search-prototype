import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} from 'baileys';
import qrcode from 'qrcode-terminal';
import { PDFParse } from 'pdf-parse';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState('./whatsapp-auth');

  const sock = makeWASocket({
    auth: state,
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
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
    if (type !== 'notify') return;

    for (const item of messages) {
      const message = item.message;
      const document =
        message?.documentMessage ??
        message?.documentWithCaptionMessage?.message?.documentMessage;

      if (!document || document.mimetype !== 'application/pdf') continue;

      let parser;

      try {
        console.log('\nPDF detected. Downloading...');
        const data = await downloadMediaMessage(item, 'buffer', {});
        const id = randomUUID();

        await mkdir('./documents', { recursive: true });
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

        console.log('PDF saved and indexed.');
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