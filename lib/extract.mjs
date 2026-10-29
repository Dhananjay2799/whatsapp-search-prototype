import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export const imageExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
]);
export const extensions = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".log",
  ".pdf",
  ".docx",
  ".xlsx",
  ...imageExtensions,
]);
export const maxBytes = 20 * 1024 * 1024;
// A PDF with less selectable text than this is treated as scanned and read with OCR.
const minPdfText = 20;
const maxOcrPages = Number(process.env.OCR_MAX_PDF_PAGES) || 5;
const ocrLangs = /^[a-z_]+(\+[a-z_]+)*$/.test(process.env.OCR_LANGS || "")
  ? process.env.OCR_LANGS
  : "eng";
// Language data is downloaded once on first use and kept here (not in git).
const ocrCache = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".ocr-cache",
);
const ocrIdleMs = 2 * 60 * 1000;
let ocrWorker = null,
  ocrBusy = 0,
  ocrIdle = null;
async function startOcr() {
  await mkdir(ocrCache, { recursive: true });
  const { createWorker } = await import("tesseract.js");
  return createWorker(ocrLangs, 1, { cachePath: ocrCache });
}
export async function ocrImage(data) {
  clearTimeout(ocrIdle);
  ocrBusy++;
  try {
    ocrWorker ??= startOcr().catch((e) => {
      ocrWorker = null;
      throw e;
    });
    const worker = await ocrWorker;
    return (await worker.recognize(Buffer.from(data))).data.text || "";
  } finally {
    // Free the OCR engine's memory when nothing has needed it for a while.
    if (--ocrBusy === 0) {
      ocrIdle = setTimeout(closeOcr, ocrIdleMs);
      ocrIdle.unref();
    }
  }
}
export async function closeOcr() {
  clearTimeout(ocrIdle);
  const pending = ocrWorker;
  ocrWorker = null;
  if (pending) await (await pending.catch(() => null))?.terminate();
}
export async function extract(data, name) {
  if (data.length > maxBytes) throw Error("File exceeds 20 MB");
  const ext = path.extname(name).toLowerCase();
  if (!extensions.has(ext)) throw Error("Unsupported file type");
  if (imageExtensions.has(ext)) return ocrImage(data);
  if (ext === ".pdf") {
    const { PDFParse } = await import("pdf-parse");
    const p = new PDFParse({ data: new Uint8Array(data) });
    try {
      const text = (await p.getText()).text || "";
      if (text.trim().length >= minPdfText) return text;
      // Scanned PDF: render the first pages as images and read them with OCR.
      const shots = await p.getScreenshot({
        first: maxOcrPages,
        scale: 2,
        imageBuffer: true,
        imageDataUrl: false,
      });
      let scanned = "";
      for (const page of shots.pages)
        scanned += (await ocrImage(page.data)) + "\n";
      return scanned.trim() ? scanned : text;
    } finally {
      await p.destroy();
    }
  }
  if (ext === ".docx") {
    const m = await import("mammoth");
    return (await m.default.extractRawText({ buffer: Buffer.from(data) }))
      .value;
  }
  if (ext === ".xlsx") {
    const { default: ExcelJS } = await import("exceljs");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(data);
    const lines = [];
    book.eachSheet((sheet) => {
      lines.push(sheet.name);
      sheet.eachRow((row) =>
        lines.push(
          row.values
            .slice(1)
            .map((v) =>
              typeof v === "object" && v !== null
                ? JSON.stringify(v)
                : String(v ?? ""),
            )
            .join("\t"),
        ),
      );
    });
    return lines.join("\n");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}
