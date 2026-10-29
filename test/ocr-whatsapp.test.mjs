import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
const temp = await mkdtemp(path.join(os.tmpdir(), "find-ocr-test-"));
process.env.SEARCH_DATA_DIR = temp;
const store = await import("../lib/store.mjs");
const { search } = await import("../lib/search.mjs");
const { extract, closeOcr } = await import("../lib/extract.mjs");
const { indexWhatsAppMessage, recordId } = await import(
  "../lib/whatsapp.mjs"
);
// OCR downloads its English language data once on first use (needs internet).
after(async () => {
  await closeOcr();
  await rm(temp, { recursive: true, force: true });
});
const fixture = (name) =>
  readFile(new URL("./fixtures/" + name, import.meta.url));
const now = Date.UTC(2026, 9, 29);
const nowSeconds = now / 1000;
let n = 0;
const key = () => ({ remoteJid: "15550001111@s.whatsapp.net", id: "MSG" + ++n });
const record = async (k) =>
  JSON.parse(
    await readFile(path.join(store.documents, recordId(k) + ".json"), "utf8"),
  );

test("photos and scanned PDFs are read with OCR", async () => {
  assert.match(await extract(await fixture("receipt.png"), "a.png"), /RECEIPT/);
  assert.match(
    await extract(await fixture("scanned-invitation.pdf"), "scan.pdf"),
    /INVITATION/,
  );
});

test("record IDs match the original connector, so existing items are not duplicated", () => {
  const k = { remoteJid: "a@s.whatsapp.net", id: "X1", fromMe: true };
  assert.equal(
    recordId(k),
    createHash("sha256")
      .update(JSON.stringify([k.remoteJid, k.id, true, ""]))
      .digest("hex"),
  );
});

test("a WhatsApp photo is OCR'd, saved, searchable as an Image and opened safely", async () => {
  const k = key();
  const item = {
    key: k,
    messageTimestamp: nowSeconds - 3600,
    message: {
      imageMessage: { mimetype: "image/png", caption: "electronics bill" },
    },
  };
  const download = async () => fixture("receipt.png");
  assert.equal(await indexWhatsAppMessage(item, { download, now }), "image");
  const r = await record(k);
  assert.equal(r.type, "image");
  assert.equal(r.contentStatus, "extracted");
  assert.match(r.text, /electronics bill/);
  assert.match(r.text, /RECEIPT/);
  const files = await readdir(store.documents);
  assert.ok(files.includes(r.imageFile));
  const found = (await search("receipt")).results.find(
    (x) => x.image === r.imageFile,
  );
  assert.equal(found.type, "Image");
  assert.equal(found.source, "whatsapp");
  // Indexing the same message again does nothing.
  assert.equal(await indexWhatsAppMessage(item, { download, now }), null);
});

test("scanned PDFs inside disappearing messages are unwrapped and read", async () => {
  const k = key();
  const item = {
    key: k,
    messageTimestamp: nowSeconds - 60,
    message: {
      ephemeralMessage: {
        message: {
          documentWithCaptionMessage: {
            message: {
              documentMessage: {
                fileName: "invite.pdf",
                mimetype: "application/pdf",
                caption: "cousin's wedding",
              },
            },
          },
        },
      },
    },
  };
  assert.equal(
    await indexWhatsAppMessage(item, {
      download: () => fixture("scanned-invitation.pdf"),
      now,
    }),
    "document",
  );
  const r = await record(k);
  assert.match(r.text, /cousin's wedding/);
  assert.match(r.text, /INVITATION/);
  assert.equal(r.pdfFile, recordId(k) + ".pdf");
});

test("old messages are skipped in recent-only mode and indexed with full history", async () => {
  const old = {
    key: key(),
    messageTimestamp: nowSeconds - 200 * 86400,
    message: { conversation: "flat lease renewal" },
  };
  const opts = { download: async () => null, indexMessages: true, now };
  assert.equal(
    await indexWhatsAppMessage(old, { ...opts, recentOnly: true }),
    null,
  );
  assert.equal(await indexWhatsAppMessage(old, opts), "message");
  assert.equal((await search("lease renewal")).total, 1);
});

test("expired documents stay searchable by name; failed photos are not recorded", async () => {
  const fail = async () => {
    throw new Error("media expired");
  };
  const doc = {
    key: key(),
    messageTimestamp: nowSeconds,
    message: { documentMessage: { fileName: "Resume_2024.docx" } },
  };
  assert.equal(
    await indexWhatsAppMessage(doc, { download: fail, now }),
    "document",
  );
  assert.match((await record(doc.key)).contentStatus, /Download failed/);
  assert.equal((await search("resume_2024")).total, 1);
  const photo = {
    key: key(),
    messageTimestamp: nowSeconds,
    message: { imageMessage: { mimetype: "image/jpeg" } },
  };
  await assert.rejects(
    indexWhatsAppMessage(photo, { download: fail, now }),
    /media expired/,
  );
  await assert.rejects(record(photo.key));
});

test("saved photos are served only to a signed-in session and only by safe name", async () => {
  const proc = spawn(process.execPath, ["server.mjs"], {
    cwd: store.root,
    env: { ...process.env, PORT: "43188" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  proc.stdout.on("data", (c) => (logs += c));
  proc.stderr.on("data", (c) => (logs += c));
  try {
    const deadline = Date.now() + 10000;
    while (!logs.includes("Search ready") && Date.now() < deadline) {
      if (proc.exitCode !== null) throw Error(logs);
      await new Promise((r) => setTimeout(r, 30));
    }
    const base = "http://localhost:43188";
    const name = (await readdir(store.documents)).find((f) =>
      f.endsWith(".png"),
    );
    assert.ok(name);
    assert.equal((await fetch(base + "/image/" + name)).status, 401);
    const { passphrase } = await store.readJSON(
      path.join(store.privateDir, "login.json"),
    );
    const logged = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ key: passphrase }),
    });
    const cookie = logged.headers.get("set-cookie").split(";")[0];
    const image = await fetch(base + "/image/" + name, {
      headers: { Cookie: cookie },
    });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    for (const bad of ["..%2Flogin.json", "x.json", "../.private/key.png"])
      assert.equal(
        (await fetch(base + "/image/" + bad, { headers: { Cookie: cookie } }))
          .status,
        404,
      );
  } finally {
    proc.kill();
    await once(proc, "exit");
  }
});
