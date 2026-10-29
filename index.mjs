import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  normalizeMessageContent,
  toNumber,
  Browsers
} from 'baileys';
import qrcode from 'qrcode-terminal';
import { PDFParse } from 'pdf-parse';
import { createWorker } from 'tesseract.js';
import { mkdir, writeFile, access } from 'node:fs/promises';

const DOCS_DIR = './documents';
const MAX_FILE_MB = 25;      // skip very large files (videos sent as documents, big zips)
const MAX_OCR_PAGES = 5;     // for scanned PDFs, only read the first few pages
const MIN_PDF_TEXT = 20;     // below this many characters, treat a PDF as scanned

await mkdir(DOCS_DIR, { recursive: true });
const ocr = await createWorker('eng');

let sock;
let indexed = 0;

// Handle one message at a time, so a big history batch doesn't overload the machine.
let queue = Promise.resolve();
function enqueue(item) {
  queue = queue.then(() => processMessage(item)).catch(error => {
    console.log('Could not process a message:', error.message);
  });
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function extensionFor(mimetype = '', filename = '') {
  const fromName = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  if (fromName && fromName.length <= 5) return fromName;
  const known = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  };
  return known[mimetype] || 'bin';
}

async function ocrImage(data) {
  const { data: result } = await ocr.recognize(Buffer.from(data));
  return result.text || '';
}

async function pdfText(data) {
  const parser = new PDFParse({ data: new Uint8Array(data) });
  try {
    const text = (await parser.getText()).text || '';
    if (text.trim().length >= MIN_PDF_TEXT) return text;

    // Scanned PDF: turn the first few pages into images and read them with OCR.
    const shots = await parser.getScreenshot({
      first: MAX_OCR_PAGES,
      scale: 2,
      imageBuffer: true,
      imageDataUrl: false
    });
    let ocrText = '';
    for (const page of shots.pages) {
      ocrText += (await ocrImage(page.data)) + '\n';
    }
    return ocrText;
  } finally {
    await parser.destroy();
  }
}

async function processMessage(item) {
  const content = normalizeMessageContent(item.message);
  const image = content?.imageMessage;
  const document = content?.documentMessage;
  const media = image || document;
  if (!media) return;

  const mimetype = media.mimetype || '';
  const filename = document?.fileName || (image ? 'Image' : 'Unnamed file');
  const sizeMb = toNumber(media.fileLength || 0) / (1024 * 1024);
  if (sizeMb > MAX_FILE_MB) return;

  const id = (item.key.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id || (await exists(`${DOCS_DIR}/${id}.json`))) return; // already indexed

  let data;
  try {
    data = await downloadMediaMessage(item, 'buffer', {}, {
      logger: sock.logger,
      reuploadRequest: sock.updateMediaMessage
    });
  } catch (error) {
    console.log(`Skipped "${filename}" (media may have expired):`, error.message);
    return;
  }

  const ext = extensionFor(mimetype, document?.fileName);
  const savedFile = `${id}.${ext}`;
  await writeFile(`${DOCS_DIR}/${savedFile}`, data);

  let text = '';
  try {
    if (mimetype === 'application/pdf') {
      text = await pdfText(data);
    } else if (mimetype.startsWith('image/')) {
      text = await ocrImage(data);
    }
    // Other files (Word, Excel, etc.) are saved and searchable by name and caption.
  } catch (error) {
    console.log(`Could not read text from "${filename}":`, error.message);
  }

  const record = {
    id,
    source: 'whatsapp',
    filename,
    fileType: ext,
    mimetype,
    chatId: item.key.remoteJid || 'Unknown',
    sender: item.key.fromMe ? 'me' : item.key.participant || item.key.remoteJid || 'Unknown',
    timestamp: toNumber(item.messageTimestamp || 0) || null,
    savedFile,
    caption: media.caption || '',
    text
  };

  // Written last, so a crash halfway through means the file is simply retried next run.
  await writeFile(`${DOCS_DIR}/${id}.json`, JSON.stringify(record, null, 2), 'utf8');
  indexed++;
  console.log(`Indexed ${ext}: ${filename} (${indexed} this session)`);
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState('./whatsapp-auth');

  sock = makeWASocket({
    auth: state,
    markOnlineOnConnect: false,
    // Ask WhatsApp for the full chat history. This needs a desktop browser identity,
    // and Baileys ignores the full-history batch unless we accept it explicitly.
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: true,
    shouldSyncHistoryMessage: () => true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nScan the QR code using WhatsApp > Linked Devices:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('\nWhatsApp connected. Old files are indexed only on the first link;');
      console.log('to re-import history, delete ./whatsapp-auth and scan the QR code again.');
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status === DisconnectReason.loggedOut) {
        console.log('Logged out. Delete ./whatsapp-auth and run again to link a new device.');
      } else {
        console.log('Connection closed; retrying in 5 seconds.');
        setTimeout(connect, 5000);
      }
    }
  });

  // Old messages, delivered in batches after linking
  sock.ev.on('messaging-history.set', ({ messages }) => {
    console.log(`History batch received: ${messages.length} messages`);
    for (const item of messages) enqueue(item);
  });

  // New messages as they arrive
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const item of messages) enqueue(item);
  });
}

process.on('SIGINT', async () => {
  await ocr.terminate();
  process.exit(0);
});

connect().catch(error => {
  console.error('Could not start:', error.message);
});
