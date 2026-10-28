import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const dataRoot = path.resolve(process.env.SEARCH_DATA_DIR || root);
export const documents = path.join(dataRoot, "documents");
export const privateDir = path.join(dataRoot, ".private");
export const hash = (s) => createHash("sha256").update(s).digest("hex");
export async function atomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + "." + randomBytes(8).toString("hex") + ".tmp";
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, file);
}
export async function readJSON(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
let key;
export async function encryptionKey() {
  if (key) return key;
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const f = path.join(privateDir, "key");
  try {
    key = await readFile(f);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    const fresh = randomBytes(32);
    try {
      await writeFile(f, fresh, { flag: "wx", mode: 0o600 });
      key = fresh;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      key = await readFile(f);
    }
  }
  if (key.length !== 32) throw Error("Invalid local encryption key");
  return key;
}
export async function saveAccounts(accounts) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", await encryptionKey(), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(accounts), "utf8"),
    cipher.final(),
  ]);
  await atomic(path.join(privateDir, "accounts.json"), {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
}
export async function accounts() {
  const saved = await readJSON(path.join(privateDir, "accounts.json"), null);
  if (!saved) return [];
  const d = createDecipheriv(
    "aes-256-gcm",
    await encryptionKey(),
    Buffer.from(saved.iv, "base64"),
  );
  d.setAuthTag(Buffer.from(saved.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      d.update(Buffer.from(saved.data, "base64")),
      d.final(),
    ]).toString(),
  );
}
export async function putRecord(id, r) {
  await atomic(path.join(documents, hash(id) + ".json"), r);
}
