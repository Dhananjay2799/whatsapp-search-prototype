import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  Browsers,
} from "baileys";
import qrcode from "qrcode-terminal";
import { indexWhatsAppMessage } from "./lib/whatsapp.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
process.chdir(path.dirname(fileURLToPath(import.meta.url)));
import { writeFile } from "node:fs/promises";
import {
  acquireConnectorLock,
  disconnectAction,
} from "./lib/connector-lifecycle.mjs";

let releaseLock;
try {
  releaseLock = await acquireConnectorLock(process.cwd());
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
let stopped = false,
  retryTimer,
  activeSocket;
async function shutdown(code = 0) {
  if (stopped) return;
  stopped = true;
  clearTimeout(retryTimer);
  connectionState = "disconnected";
  try {
    activeSocket?.end(new Error("Connector stopped"));
  } catch {}
  await publishStatus();
  await releaseLock();
  process.exit(code);
}
process.once("SIGINT", () => shutdown());
process.once("SIGTERM", () => shutdown());

const indexMessages = process.env.INDEX_MESSAGES === "1";
console.log(
  indexMessages
    ? "Text message indexing is ON. New message text will be saved in the documents folder."
    : "Text message indexing is OFF. Set INDEX_MESSAGES=1 before starting to enable it. Document and photo indexing remains on.",
);
const fullHistory = process.env.WHATSAPP_FULL_HISTORY === "1";
console.log(
  fullHistory
    ? "Full WhatsApp history is ON. WhatsApp sends it only when this device is first linked: to import it, unlink this device on your phone, delete the whatsapp-auth folder and scan a new QR code."
    : "Full WhatsApp history is OFF; only the last 24 hours are caught up. Set WHATSAPP_FULL_HISTORY=1 to import older chats.",
);

// Handle one message at a time, so a large history sync doesn't overload the computer.
let queue = Promise.resolve();
function enqueue(item, { recentOnly, live }) {
  queue = queue
    .then(() =>
      indexWhatsAppMessage(item, {
        download: (media) =>
          downloadMediaMessage(
            media,
            "buffer",
            {},
            // Lets WhatsApp ask your phone to re-upload media that has expired.
            {
              logger: activeSocket.logger,
              reuploadRequest: activeSocket.updateMediaMessage,
            },
          ),
        indexMessages,
        recentOnly,
      }),
    )
    .then((kind) => {
      if (kind === "document" || kind === "image")
        console.log(live ? `New ${kind} indexed.` : `Older ${kind} indexed.`);
      else if (kind === "message" && live) console.log("Text message indexed.");
    })
    .catch((error) => {
      console.log("Could not index a WhatsApp item:", error.message);
    });
}

let connectionState = "connecting";
async function publishStatus() {
  try {
    await writeFile(
      "./.connector-status.json",
      JSON.stringify({ state: connectionState, updatedAt: Date.now() }),
      "utf8",
    );
  } catch (error) {
    console.error("Status update failed:", error.message);
  }
}
setInterval(publishStatus, 10000).unref();
publishStatus();

async function connect() {
  if (stopped) return;
  const { state, saveCreds } = await useMultiFileAuthState("./whatsapp-auth");

  const sock = makeWASocket({
    auth: state,
    markOnlineOnConnect: false,
    // Full history needs a desktop identity, and Baileys drops the full-history
    // batch unless it is accepted explicitly.
    ...(fullHistory && {
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
    }),
  });

  activeSocket = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (stopped || sock !== activeSocket) return;
    if (connection) {
      connectionState =
        connection === "open"
          ? "connected"
          : connection === "close"
            ? "disconnected"
            : "connecting";
      publishStatus();
    }
    if (qr) {
      console.log("\nScan the QR code using WhatsApp Linked Devices:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("\nWhatsApp connected successfully.");
    }

    if (connection === "close") {
      const status = lastDisconnect?.error?.output?.statusCode;

      const action = disconnectAction(status, DisconnectReason);
      if (action === "replaced") {
        console.error(
          "WhatsApp connection was replaced by another connector using this linked-device session. Stop the earlier connector, then run npm.cmd run dev once. Automatic retries have been stopped.",
        );
        void shutdown(1);
      } else if (action === "stop") {
        console.error(
          "WhatsApp authorization requires attention. Automatic retries have stopped. Check Linked Devices before reconnecting.",
        );
        void shutdown(1);
      } else if (!retryTimer) {
        console.log("Connection closed; retrying in 5 seconds.");
        retryTimer = setTimeout(() => {
          retryTimer = null;
          connect().catch((error) => {
            console.error("Reconnect failed:", error.message);
            void shutdown(1);
          });
        }, 5000);
      }
    }
  });

  sock.ev.on("messages.upsert", ({ type, messages }) => {
    if (type !== "notify" && type !== "append") return;
    for (const item of messages)
      enqueue(item, {
        // Without full history, limit catch-up to recent messages.
        recentOnly: type === "append" && !fullHistory,
        live: type === "notify",
      });
  });

  if (fullHistory)
    sock.ev.on("messaging-history.set", ({ messages, progress }) => {
      console.log(
        `History batch received: ${messages.length} messages` +
          (typeof progress === "number" ? ` (${progress}% of history synced)` : ""),
      );
      for (const item of messages)
        enqueue(item, { recentOnly: false, live: false });
    });
}

connect().catch((error) => {
  console.error("Could not start:", error.message);
  void shutdown(1);
});
