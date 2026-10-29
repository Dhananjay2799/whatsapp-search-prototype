import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
const temp = await mkdtemp(path.join(os.tmpdir(), "find-test-"));
process.env.SEARCH_DATA_DIR = temp;
const store = await import("../lib/store.mjs");
const { search, resultFor } = await import("../lib/search.mjs");
const { extract } = await import("../lib/extract.mjs");
const mail = await import("../lib/mail.mjs");
after(() => rm(temp, { recursive: true, force: true }));
test("filename, path, Gujarati and equivalent Unicode search preserve legacy WhatsApp records", async () => {
  await store.putRecord("legacy", {
    type: "message",
    chatId: "test-chat",
    text: "cafe\u0301 આમંત્રણ",
    timestamp: 10,
  });
  await store.putRecord("file", {
    source: "files",
    filename: "Resume.docx",
    location: "C:\\Documents\\Resume.docx",
    text: "Backend developer",
  });
  assert.equal((await search("café")).total, 1);
  assert.equal((await search("આમંત્રણ")).total, 1);
  assert.equal((await search("resume", "files")).total, 1);
  assert.equal((await search("resume", "gmail")).total, 0);
  assert.equal(
    resultFor(
      { text: "needle", openUrl: "https://evil.test/", pdfFile: "../x.pdf" },
      "id",
      "needle",
    ).openUrl,
    null,
  );
});
test("file extraction reads DOCX and XLSX text without HTML execution", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Recipes").addRow(["આમંત્રણ", "resume"]);
  const text = await extract(
    Buffer.from(await wb.xlsx.writeBuffer()),
    "sheet.xlsx",
  );
  assert.match(text, /આમંત્રણ/);
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Resume engineer</w:t></w:r></w:p></w:body></w:document>',
  );
  assert.match(
    await extract(
      await zip.generateAsync({ type: "nodebuffer" }),
      "resume.docx",
    ),
    /Resume engineer/,
  );
  await assert.rejects(
    extract(Buffer.from("video"), "clip.mp4"),
    /Unsupported/,
  );
});
test("Gmail sync includes spam/trash, indexes attachments and encrypts credentials", async () => {
  await store.saveAccounts([
    {
      id: "gmail-test",
      provider: "gmail",
      email: "test@example.com",
      accessToken: "secret-access",
      refreshToken: "secret-refresh",
      expires: Date.now() + 3600000,
    },
  ]);
  const raw = await readFile(
    path.join(store.privateDir, "accounts.json"),
    "utf8",
  );
  assert.ok(!raw.includes("secret-access"));
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (u) => {
    const url = new URL(u);
    calls.push(url);
    let body;
    if (url.pathname.endsWith("/labels"))
      body = { labels: [{ id: "SPAM", name: "Spam" }] };
    else if (url.pathname.endsWith("/messages"))
      body = { messages: [{ id: "message-1" }] };
    else
      body = {
        id: "message-1",
        internalDate: "1700000000000",
        labelIds: ["SPAM"],
        payload: {
          headers: [{ name: "Subject", value: "Resume invitation" }],
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "text/plain",
              body: {
                data: Buffer.from("Birthday invitation").toString("base64url"),
              },
            },
            {
              filename: "resume.txt",
              body: {
                data: Buffer.from("Go developer résumé").toString("base64url"),
              },
            },
          ],
        },
      };
    return new Response(JSON.stringify(body));
  };
  try {
    const coverage = await mail.syncAccount("gmail-test", false, {
      wait: async () => {},
    });
    assert.equal(coverage.messages, 1);
    assert.equal(coverage.attachments, 1);
    assert.equal(
      calls
        .find((u) => u.pathname.endsWith("/messages"))
        .searchParams.get("includeSpamTrash"),
      "true",
    );
    assert.equal((await search("résumé", "gmail")).total, 1);
    assert.match(
      (await search("invitation", "gmail")).results[0].location,
      /Spam/,
    );
  } finally {
    global.fetch = realFetch;
  }
  await mail.disconnect("gmail-test");
  assert.equal((await search("invitation", "gmail")).total, 0);
  assert.equal((await store.accounts()).length, 0);
});
test("Outlook sync resolves folders and extracts attachment text", async () => {
  await store.saveAccounts([
    {
      id: "outlook-test",
      provider: "outlook",
      email: "school@example.edu",
      accessToken: "access",
      expires: Date.now() + 3600000,
    },
  ]);
  const realFetch = global.fetch;
  global.fetch = async (u) => {
    const url = new URL(u);
    let body;
    if (url.pathname.endsWith("/attachments"))
      body = {
        value: [
          {
            id: "at",
            name: "classroom.txt",
            size: 10,
            contentBytes: Buffer.from("Classroom handout").toString("base64"),
          },
        ],
      };
    else if (url.pathname.includes("/mailFolders/"))
      body = { displayName: "Deleted Items" };
    else
      body = {
        value: [
          {
            id: "m",
            subject: "Classroom",
            body: { contentType: "text", content: "Schedule" },
            receivedDateTime: "2026-01-01",
            parentFolderId: "deleted",
            hasAttachments: true,
            webLink: "https://outlook.office.com/mail/test",
          },
        ],
      };
    return new Response(JSON.stringify(body));
  };
  try {
    await mail.syncAccount("outlook-test");
    assert.equal((await search("handout", "outlook")).total, 1);
    assert.match(
      (await search("handout", "outlook")).results[0].location,
      /Deleted Items/,
    );
  } finally {
    global.fetch = realFetch;
  }
  await mail.disconnect("outlook-test");
});
test("HTTP server requires login, rejects CSRF and unexpected hosts, serves authenticated search", async () => {
  const proc = spawn(process.execPath, ["server.mjs"], {
    cwd: store.root,
    env: { ...process.env, PORT: "43187" },
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
    assert.match(logs, /Search ready/);
    const base = "http://localhost:43187";
    assert.equal((await fetch(base + "/api/search?q=resume")).status, 401);
    const { request } = await import("node:http");
    const rejected = await new Promise((resolve, reject) => {
      const req = request(
        base,
        { headers: { Host: "attacker.test" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(rejected, 403);
    const key = (
      await store.readJSON(path.join(store.privateDir, "login.json"))
    ).passphrase;
    assert.equal(
      (
        await fetch(base + "/api/login", {
          method: "POST",
          headers: { Origin: "https://evil.test" },
          body: JSON.stringify({ key }),
        })
      ).status,
      403,
    );
    const logged = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    assert.equal(logged.status, 200);
    const cookie = logged.headers.get("set-cookie").split(";")[0];
    const results = await fetch(base + "/api/search?q=resume", {
      headers: { Cookie: cookie },
    });
    assert.equal(results.status, 200);
    assert.ok((await results.json()).results.length);
    const status = await (
      await fetch(base + "/api/status", { headers: { Cookie: cookie } })
    ).json();
    assert.equal(status.local, true);
    assert.match(status.sources.messages, /not connected/);
  } finally {
    proc.kill();
    await once(proc, "exit");
  }
});

test("OAuth uses PKCE and rejects a callback from another session", async () => {
  process.env.GOOGLE_CLIENT_ID = "test-client";
  const auth = new URL(mail.beginConnect("gmail", "original-session"));
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    auth.searchParams.get("scope"),
    "https://www.googleapis.com/auth/gmail.readonly",
  );
  const params = new URLSearchParams({
    state: auth.searchParams.get("state"),
    code: "fake-code",
  });
  await assert.rejects(
    mail.finishConnect("gmail", params, "other-session"),
    /invalid/,
  );
  assert.equal((await store.accounts()).length, 0);
});

test("Gmail pagination reports partial coverage and resumes older mail without duplicates", async () => {
  await store.saveAccounts([
    {
      id: "paged",
      provider: "gmail",
      email: "paged@example.com",
      accessToken: "access",
      expires: Date.now() + 3600000,
    },
  ]);
  const realFetch = global.fetch;
  const pageTokens = [];
  global.fetch = async (u) => {
    const url = new URL(u);
    let body;
    if (url.pathname.endsWith("/labels")) body = { labels: [] };
    else if (url.pathname.endsWith("/messages")) {
      const n = Number(url.searchParams.get("pageToken") || 0);
      pageTokens.push(n);
      body = {
        messages: Array.from({ length: 25 }, (_, i) => ({
          id: "m" + (n * 25 + i),
        })),
        ...(n < 8 ? { nextPageToken: String(n + 1) } : {}),
      };
    } else
      body = {
        id: url.pathname.split("/").pop(),
        internalDate: "1700000000000",
        payload: {
          headers: [{ name: "Subject", value: "Paged example" }],
          mimeType: "text/plain",
          body: {
            data: Buffer.from("unique-page-content").toString("base64url"),
          },
        },
      };
    return new Response(JSON.stringify(body));
  };
  try {
    const first = await mail.syncAccount("paged", false, {
      wait: async () => {},
    });
    assert.equal(first.messages, 200);
    assert.equal(first.partial, true);
    assert.equal(first.next, "8");
    const second = await mail.syncAccount("paged", true, {
      wait: async () => {},
    });
    assert.equal(second.messages, 25);
    assert.equal(second.partial, false);
    assert.equal(pageTokens.at(-1), 8);
    assert.equal((await search("unique-page-content", "gmail")).total, 225);
    assert.equal((await search("unique-page-content", "gmail")).limited, true);
  } finally {
    global.fetch = realFetch;
    await mail.disconnect("paged");
  }
});

test("folder import indexes nested files, records full paths and skips symlinks", async () => {
  const fixture = path.join(temp, "folder");
  await (
    await import("node:fs/promises")
  ).mkdir(path.join(fixture, "nested"), { recursive: true });
  await writeFile(
    path.join(fixture, "nested", "note.txt"),
    "local-folder-needle",
  );
  const { symlink } = await import("node:fs/promises");
  await symlink(path.join(fixture, "nested"), path.join(fixture, "shortcut"));
  const proc = spawn(process.execPath, ["import-files.mjs", fixture], {
    cwd: store.root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (c) => (output += c));
  proc.stderr.on("data", (c) => (output += c));
  const [code] = await once(proc, "exit");
  assert.equal(code, 0, output);
  const results = await search("local-folder-needle");
  assert.equal(results.total, 1);
  assert.equal(
    results.results[0].location,
    path.join(fixture, "nested", "note.txt"),
  );
});
