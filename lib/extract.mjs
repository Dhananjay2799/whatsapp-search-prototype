import path from "node:path";
export const extensions = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".log",
  ".pdf",
  ".docx",
  ".xlsx",
]);
export const maxBytes = 20 * 1024 * 1024;
export async function extract(data, name) {
  if (data.length > maxBytes) throw Error("File exceeds 20 MB");
  const ext = path.extname(name).toLowerCase();
  if (!extensions.has(ext)) throw Error("Unsupported file type");
  if (ext === ".pdf") {
    const { PDFParse } = await import("pdf-parse");
    const p = new PDFParse({ data: new Uint8Array(data) });
    try {
      return (await p.getText()).text || "";
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
