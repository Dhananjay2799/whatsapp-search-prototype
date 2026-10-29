import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { root, documents, privateDir, readJSON, atomic } from "./lib/store.mjs";
import { search, savedImage } from "./lib/search.mjs";
import {
  configured,
  beginConnect,
  finishConnect,
  publicAccounts,
  syncAccount,
  syncBusy,
  disconnect,
} from "./lib/mail.mjs";
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const port = Number(process.env.PORT || 3000),
  tailnetHost = (process.env.TAILSCALE_HOST || "").trim().toLowerCase();
if (
  tailnetHost &&
  !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(
    tailnetHost,
  )
)
  throw Error("TAILSCALE_HOST must be an exact .ts.net hostname");
let login = await readJSON(path.join(privateDir, "login.json"), null);
if (!login) {
  login = { passphrase: randomBytes(24).toString("base64url") };
  await atomic(path.join(privateDir, "login.json"), login);
}
console.log(
  "Personal search access key (enter on your phone; do not share):",
  login.passphrase,
);
const sessions = new Map(),
  attempts = new Map();
const digest = (s) => createHash("sha256").update(String(s)).digest();
function session(req) {
  const c = (req.headers.cookie || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("search_session="))
    ?.slice(15);
  const s = sessions.get(c);
  return s && s.expires > Date.now() ? c : null;
}
async function jsonBody(req) {
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 8192) throw Error("Request too large");
  }
  return JSON.parse(raw || "{}");
}
const json = (res, n, data) =>
  res
    .writeHead(n, { "Content-Type": "application/json; charset=utf-8" })
    .end(JSON.stringify(data));
const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  const host = (req.headers.host || "").toLowerCase(),
    local = host === `localhost:${port}` || host === `127.0.0.1:${port}`;
  if (
    !local &&
    (!tailnetHost || (host !== tailnetHost && host !== `${tailnetHost}:443`))
  ) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "POST") {
      const expected = (local ? "http://" : "https://") + host;
      if (req.headers.origin !== expected)
        return json(res, 403, { error: "Origin rejected" });
    }
    if (
      req.method === "GET" &&
      ["/", "/app.js", "/style.css"].includes(url.pathname)
    ) {
      const f = url.pathname === "/" ? "phone.html" : url.pathname.slice(1);
      res
        .writeHead(200, {
          "Content-Type": f.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : f.endsWith(".css")
              ? "text/css; charset=utf-8"
              : "text/html; charset=utf-8",
        })
        .end(await readFile(path.join(root, f)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/login") {
      const peer = req.socket.remoteAddress;
      const a = attempts.get(peer) || { count: 0, start: Date.now() };
      if (Date.now() - a.start > 60000) {
        a.count = 0;
        a.start = Date.now();
      }
      if (++a.count > 10)
        return json(res, 429, { error: "Too many attempts; wait one minute" });
      attempts.set(peer, a);
      const b = await jsonBody(req);
      if (!timingSafeEqual(digest(b.key), digest(login.passphrase)))
        return json(res, 401, { error: "Incorrect access key" });
      for (const [k, v] of sessions)
        if (v.expires < Date.now()) sessions.delete(k);
      const token = randomBytes(32).toString("hex");
      sessions.set(token, { expires: Date.now() + 12 * 3600000 });
      res.setHeader(
        "Set-Cookie",
        `search_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${local ? "" : "; Secure"}`,
      );
      return json(res, 200, { ok: true });
    }
    const sid = session(req);
    if (!sid)
      return json(res, 401, {
        error: "Sign in with the access key printed by the server",
      });
    if (req.method === "POST" && url.pathname === "/api/logout") {
      sessions.delete(sid);
      res.setHeader(
        "Set-Cookie",
        "search_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      );
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      let connector = { state: "offline" };
      try {
        const s = await readJSON(path.join(root, ".connector-status.json"), {});
        if (
          Date.now() - s.updatedAt < 25000 &&
          ["connected", "connecting", "disconnected"].includes(s.state)
        )
          connector = { state: s.state };
      } catch {}
      const accts = (await publicAccounts()).map((a) => ({
        ...a,
        coverage: a.coverage
          ? { ...a.coverage, next: Boolean(a.coverage.next) }
          : null,
      }));
      return json(res, 200, {
        ...connector,
        accounts: accts,
        syncing: syncBusy(),
        local,
        configured: {
          gmail: configured("gmail"),
          outlook: configured("outlook"),
        },
        sources: {
          messages:
            "iPhone Messages is not connected. Automatic full-history access is unavailable in this app.",
          files:
            "Only explicitly imported files and folders are searchable. Text in photos and scanned PDFs is read with OCR.",
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q || q.length > 200)
        return json(res, 400, {
          error: "Enter a search term of up to 200 characters",
        });
      return json(
        res,
        200,
        await search(q, url.searchParams.get("source") || "all"),
      );
    }
    const connect = url.pathname.match(/^\/api\/connect\/(gmail|outlook)$/);
    if (req.method === "POST" && connect) {
      if (!local)
        return json(res, 403, {
          error:
            "Connect accounts from http://localhost:" +
            port +
            " on your computer",
        });
      if (syncBusy())
        return json(res, 409, { error: "Wait for the current sync to finish" });
      return json(res, 200, { url: beginConnect(connect[1], sid) });
    }
    const callback = url.pathname.match(/^\/auth\/(gmail|outlook)\/callback$/);
    if (req.method === "GET" && callback) {
      if (!local || syncBusy())
        return json(res, 409, {
          error: "Open account sign-in on the computer after sync finishes",
        });
      await finishConnect(callback[1], url.searchParams, sid);
      res.writeHead(303, { Location: "/" }).end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/sync") {
      if (syncBusy())
        return json(res, 409, { error: "A sync is already running" });
      const b = await jsonBody(req);
      if (!(await publicAccounts()).some((a) => a.id === b.id))
        return json(res, 404, { error: "Account not found" });
      syncAccount(b.id, b.older === true).catch((e) =>
        console.error("Email sync:", e.message),
      );
      return json(res, 202, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/disconnect") {
      const b = await jsonBody(req);
      await disconnect(b.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname.startsWith("/pdf/")) {
      const name = url.pathname.slice(5);
      if (!/^[0-9a-f-]+\.pdf$/i.test(name)) {
        res.writeHead(404).end();
        return;
      }
      try {
        const data = await readFile(path.join(documents, name));
        res
          .writeHead(200, {
            "Content-Type": "application/pdf",
            "Content-Disposition": "inline",
          })
          .end(data);
      } catch (e) {
        if (!res.headersSent) res.writeHead(404);
        res.end();
      }
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/image/")) {
      const name = url.pathname.slice(7);
      if (!savedImage.test(name)) {
        res.writeHead(404).end();
        return;
      }
      const ext = path.extname(name).toLowerCase();
      try {
        const data = await readFile(path.join(documents, name));
        res
          .writeHead(200, {
            "Content-Type":
              ext === ".png"
                ? "image/png"
                : ext === ".webp"
                  ? "image/webp"
                  : ext === ".bmp"
                    ? "image/bmp"
                    : "image/jpeg",
            "Content-Disposition": "inline",
          })
          .end(data);
      } catch {
        if (!res.headersSent) res.writeHead(404);
        res.end();
      }
      return;
    }
    res.writeHead(404).end("Not found");
  } catch (e) {
    json(res, 400, { error: e.message || "Unable to complete request" });
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Search ready at http://localhost:${port}`),
);
