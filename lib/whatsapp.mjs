import path from "node:path";
import { mkdir, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { normalizeMessageContent, toNumber } from "baileys";
import { extract, extensions, imageExtensions, maxBytes } from "./extract.mjs";
import { documents } from "./store.mjs";

export const recentWindowSeconds = 86400;
const imageTypes = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

// Same ID scheme as the original connector, so already indexed items are not duplicated.
export function recordId(key) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        key.remoteJid,
        key.id,
        !!key.fromMe,
        key.participant || "",
      ]),
    )
    .digest("hex");
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Index one WhatsApp message: its text (when enabled), a document, or a photo.
 * `download(item)` returns the media bytes. With `recentOnly`, messages older than
 * 24 hours are ignored. Returns what was indexed ("message", "document", "image") or null.
 */
export async function indexWhatsAppMessage(
  item,
  { download, indexMessages = false, recentOnly = false, now = Date.now() },
) {
  if (!item?.key?.id || !item.key.remoteJid) return null;
  const timestamp = toNumber(item.messageTimestamp || 0) || null;
  if (recentOnly && (!timestamp || timestamp < now / 1000 - recentWindowSeconds))
    return null;
  // Unwraps disappearing, view-once, edited and captioned-document messages.
  const content = normalizeMessageContent(item.message);
  if (!content) return null;

  const id = recordId(item.key);
  const jsonFile = path.join(documents, `${id}.json`);
  const chatId = item.key.remoteJid || "Unknown";
  await mkdir(documents, { recursive: true });

  const message = content.conversation ?? content.extendedTextMessage?.text;
  if (typeof message === "string" && message.trim()) {
    if (!indexMessages) return null;
    try {
      await writeFile(
        jsonFile,
        JSON.stringify(
          {
            type: "message",
            filename: "WhatsApp message",
            chatId,
            timestamp,
            text: message,
          },
          null,
          2,
        ),
        { encoding: "utf8", flag: "wx" },
      );
      return "message";
    } catch (error) {
      if (error.code === "EEXIST") return null;
      throw error;
    }
  }

  const document = content.documentMessage;
  const photo = content.imageMessage;
  const media = document || photo;
  if (!media || (await exists(jsonFile))) return null;

  const filename = document
    ? document.fileName || "Unnamed document"
    : "WhatsApp photo";
  const ext = document
    ? path.extname(filename).toLowerCase()
    : imageTypes[photo.mimetype] || ".jpg";
  const isImage = imageExtensions.has(ext);
  const size = toNumber(media.fileLength || 0);
  let text = "",
    pdfFile = null,
    imageFile = null,
    contentStatus = "Content extraction is not supported for this document";

  if (!extensions.has(ext)) {
    // Unsupported document types stay searchable by filename and caption.
  } else if (size > maxBytes) {
    contentStatus = "Document exceeds the 20 MB content extraction limit";
  } else {
    let data;
    try {
      data = await download(item);
    } catch (error) {
      // A photo with no file and no text is not worth a search result.
      if (isImage) throw error;
      contentStatus =
        "Download failed (the file may have expired on WhatsApp); search the filename";
    }
    if (data && data.length > maxBytes) {
      contentStatus = "Document exceeds the 20 MB content extraction limit";
    } else if (data) {
      try {
        text = await extract(data, filename + (document ? "" : ext));
        contentStatus = text.trim()
          ? "extracted"
          : "No readable text found; search the filename";
      } catch {
        contentStatus = "Text extraction failed; search the filename";
      }
      if (ext === ".pdf") {
        pdfFile = `${id}.pdf`;
        await writeFile(path.join(documents, pdfFile), data);
      } else if (isImage) {
        imageFile = `${id}${ext}`;
        await writeFile(path.join(documents, imageFile), data);
      }
    }
  }

  const caption = String(media.caption || "").trim();
  await writeFile(
    jsonFile,
    JSON.stringify(
      {
        type: isImage ? "image" : "attachment",
        source: "whatsapp",
        filename,
        contentStatus,
        chatId,
        timestamp,
        pdfFile,
        imageFile,
        text: caption && text ? caption + "\n" + text : caption || text,
      },
      null,
      2,
    ),
    "utf8",
  );
  return isImage ? "image" : "document";
}
