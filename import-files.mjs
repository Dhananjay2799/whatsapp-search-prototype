import { readdir, readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { extract, extensions, maxBytes, closeOcr } from "./lib/extract.mjs";
import { putRecord } from "./lib/store.mjs";
const args = process.argv.slice(2),
  seen = new Set();
let indexed = 0,
  skipped = 0,
  failed = 0;
async function visit(file) {
  const stat = await lstat(file);
  if (stat.isSymbolicLink()) {
    skipped++;
    return;
  }
  if (stat.isDirectory()) {
    if (
      [
        "node_modules",
        ".git",
        ".private",
        "whatsapp-auth",
        "documents",
      ].includes(path.basename(file))
    ) {
      skipped++;
      return;
    }
    for (const e of await readdir(file))
      await visit(path.join(file, e)).catch((e) => {
        failed++;
        console.error("Skipped:", path.basename(file), e.message);
      });
    return;
  }
  if (!stat.isFile() || !extensions.has(path.extname(file).toLowerCase())) {
    skipped++;
    return;
  }
  if (stat.size > maxBytes) throw Error("File exceeds 20 MB");
  const absolute = await realpath(file);
  if (seen.has(absolute)) return;
  seen.add(absolute);
  const text = await extract(await readFile(file), file);
  await putRecord("local:" + absolute, {
    source: "files",
    type: "file",
    filename: path.basename(file),
    location: absolute,
    timestamp: Math.floor(stat.mtimeMs / 1000),
    text,
    contentStatus: text.trim()
      ? "extracted"
      : "No readable text found; search the filename",
  });
  indexed++;
  console.log("Indexed:", absolute);
}
if (!args.length) {
  console.error('Usage: node import-files.mjs "C:\\path\\to\\folder-or-file"');
  process.exitCode = 1;
} else {
  for (const p of args)
    await visit(path.resolve(p)).catch((e) => {
      failed++;
      console.error("Import failed:", e.message);
    });
  await closeOcr();
  console.log(JSON.stringify({ indexed, skipped, failed }));
  if (failed) process.exitCode = 1;
}
