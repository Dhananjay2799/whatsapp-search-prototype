import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} from "baileys";
import qrcode from "qrcode-terminal";
import { extract, extensions, maxBytes } from "./lib/extract.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
process.chdir(path.dirname(fileURLToPath(import.meta.url)));
import { mkdir, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
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
    : "Text message indexing is OFF. Set INDEX_MESSAGES=1 before starting to enable it. PDF indexing remains on.",
);

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

  sock.ev.on("messages.upsert", async ({ type, messages }) => {
    if (type !== "notify" && type !== "append") return;

    for (const item of messages) {
      // Limit catch-up to recent messages; do not silently import full history.
      const timestamp = Number(item.messageTimestamp);
      if (
        type === "append" &&
        (!timestamp || timestamp < Date.now() / 1000 - 86400)
      )
        continue;
      const message = item.message;
      const document =
        message?.documentMessage ??
        message?.documentWithCaptionMessage?.message?.documentMessage;

      const text = message?.conversation ?? message?.extendedTextMessage?.text;
      if (indexMessages && typeof text === "string" && text.trim()) {
        try {
          await mkdir("./documents", { recursive: true });
          if (!item.key?.id || !item.key?.remoteJid) continue;
          const id = createHash("sha256")
            .update(
              JSON.stringify([
                item.key.remoteJid,
                item.key.id,
                !!item.key.fromMe,
                item.key.participant || "",
              ]),
            )
            .digest("hex");
          const record = {
            type: "message",
            filename: "WhatsApp message",
            chatId: item.key.remoteJid || "Unknown",
            timestamp: Number(item.messageTimestamp) || null,
            text,
          };
          await writeFile(
            `./documents/${id}.json`,
            JSON.stringify(record, null, 2),
            { encoding: "utf8", flag: "wx" },
          );
          console.log(
            type === "append"
              ? "Recent synced text message indexed."
              : "Text message indexed.",
          );
        } catch (error) {
          if (error.code !== "EEXIST")
            console.log("Could not index message:", error.message);
        }
      }
      if (!document) continue;
      if (!item.key?.id || !item.key?.remoteJid) continue;

      try {
        console.log("\nDocument detected. Indexing...");
        const id = createHash("sha256")
          .update(
            JSON.stringify([
              item.key.remoteJid,
              item.key.id,
              !!item.key.fromMe,
              item.key.participant || "",
            ]),
          )
          .digest("hex");
        await mkdir("./documents", { recursive: true });
        try {
          await access(`./documents/${id}.json`);
          continue;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const filename = document.fileName || "Unnamed document";
        const ext = path.extname(filename).toLowerCase();
        let text = "",
          pdfFile = null,
          contentStatus =
            "Content extraction is not supported for this document";
        if (
          extensions.has(ext) &&
          Number(document.fileLength || 0) <= maxBytes
        ) {
          const data = await downloadMediaMessage(item, "buffer", {});
          if (data.length <= maxBytes) {
            try {
              text = await extract(data, filename);
              contentStatus = text.trim()
                ? "extracted"
                : "No text extracted; OCR may be required";
            } catch {
              contentStatus = "Text extraction failed; search the filename";
            }
            if (ext === ".pdf") {
              pdfFile = `${id}.pdf`;
              await writeFile(`./documents/${pdfFile}`, data);
            }
          } else
            contentStatus =
              "Document exceeds the 20 MB content extraction limit";
        }

        const record = {
          type: "attachment",
          source: "whatsapp",
          filename,
          contentStatus,
          chatId: item.key.remoteJid || "Unknown",
          timestamp: Number(item.messageTimestamp) || null,
          pdfFile,
          text,
        };

        await writeFile(
          `./documents/${id}.json`,
          JSON.stringify(record, null, 2),
          "utf8",
        );

        console.log(
          type === "append"
            ? "Recent synced document indexed."
            : "Document indexed.",
        );
        if (!record.text.trim()) {
          console.log(
            "No selectable text found; this PDF may need image recognition.",
          );
        }
      } catch (error) {
        console.log("Could not process PDF:", error.message);
      }
    }
  });
}

connect().catch((error) => {
  console.error("Could not start:", error.message);
  void shutdown(1);
});
