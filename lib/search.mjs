import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { documents } from "./store.mjs";
import { imageExtensions } from "./extract.mjs";
export const savedImage = /^[0-9a-f]+\.(jpe?g|png|webp|bmp)$/i;
export const normalize = (s) =>
  String(s || "")
    .normalize("NFC")
    .toLocaleLowerCase();
export function resultFor(r, file, q) {
  const source = r.source || (r.type === "text-file" ? "files" : "whatsapp");
  const title =
    r.filename || (r.type === "message" ? "WhatsApp message" : "PDF");
  const text = String(r.text || "");
  const hay = normalize(
    title + "\n" + (r.location || r.chatId || "") + "\n" + text,
  );
  if (!hay.includes(normalize(q))) return null;
  const at = normalize(text).indexOf(normalize(q));
  const excerpt = text
    .slice(Math.max(0, at - 70), Math.max(0, at) + q.length + 160)
    .replace(/\s+/g, " ");
  const type =
    r.type === "message"
      ? "Message"
      : r.type === "email"
        ? "Email"
        : r.type === "attachment"
          ? "Attachment"
          : r.type === "image"
            ? "Image"
            : r.type === "text-file"
              ? "Text file"
              : r.type === "file"
                ? imageExtensions.has(path.extname(title).toLowerCase())
                  ? "Image"
                  : path.extname(title).slice(1).toUpperCase() || "File"
                : "PDF";
  const pdf =
    typeof r.pdfFile === "string" && /^[0-9a-f-]+\.pdf$/i.test(r.pdfFile)
      ? r.pdfFile
      : null;
  const image =
    typeof r.imageFile === "string" && savedImage.test(r.imageFile)
      ? r.imageFile
      : null;
  let openUrl = null;
  try {
    const u = new URL(r.openUrl);
    if (
      u.protocol === "https:" &&
      [
        "mail.google.com",
        "outlook.live.com",
        "outlook.office.com",
        "outlook.office365.com",
      ].includes(u.hostname)
    )
      openUrl = u.href;
  } catch {}
  return {
    id: file,
    source,
    type,
    filename: title,
    location: r.location || r.chatId || "Unknown",
    account: r.account || null,
    chatId: r.chatId || "",
    timestamp: Number(r.timestamp) || null,
    excerpt,
    pdf,
    image,
    openUrl,
    contentStatus: r.contentStatus || null,
    score: normalize(title).includes(normalize(q)) ? 2 : 1,
  };
}
export async function search(q, source = "all") {
  const files = await readdir(documents).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  const results = [];
  let invalid = 0;
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const r = resultFor(
        JSON.parse(await readFile(path.join(documents, file), "utf8")),
        file,
        q,
      );
      if (r && (source === "all" || r.source === source)) results.push(r);
    } catch {
      invalid++;
    }
  }
  results.sort(
    (a, b) => b.score - a.score || (b.timestamp || 0) - (a.timestamp || 0),
  );
  return {
    results: results.slice(0, 200),
    total: results.length,
    limited: results.length > 200,
    invalid,
  };
}
