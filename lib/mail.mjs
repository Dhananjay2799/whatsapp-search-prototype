import { providerError } from "./provider-error.mjs";
import { randomBytes, createHash } from "node:crypto";
import { accounts, saveAccounts, putRecord } from "./store.mjs";
import { extract, extensions, maxBytes } from "./extract.mjs";
import path from "node:path";
const definitions = {
  gmail: {
    client: "GOOGLE_CLIENT_ID",
    secret: "GOOGLE_CLIENT_SECRET",
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
  },
  outlook: {
    client: "MICROSOFT_CLIENT_ID",
    secret: "MICROSOFT_CLIENT_SECRET",
    auth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope:
      "offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read",
  },
};
const pending = new Map();
let busy = false;
export const configured = (p) =>
  Boolean(definitions[p] && process.env[definitions[p].client]);
const redirect = (p) =>
  `http://localhost:${Number(process.env.PORT || 3000)}/auth/${p}/callback`;
async function request(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw Error(providerError(r.status, body));
  }
  return r.json();
}
function tokenParams(p, values) {
  const d = definitions[p],
    body = new URLSearchParams({ client_id: process.env[d.client], ...values });
  if (process.env[d.secret]) body.set("client_secret", process.env[d.secret]);
  return body;
}
export function beginConnect(p, session) {
  if (!configured(p))
    throw Error("Configure the provider client ID in .env first");
  for (const [s, v] of pending) if (v.expires < Date.now()) pending.delete(s);
  if (pending.size > 50) throw Error("Too many sign-in attempts");
  const state = randomBytes(24).toString("hex"),
    verifier = randomBytes(48).toString("base64url");
  pending.set(state, { p, session, verifier, expires: Date.now() + 600000 });
  const u = new URL(definitions[p].auth);
  u.search = new URLSearchParams({
    client_id: process.env[definitions[p].client],
    redirect_uri: redirect(p),
    response_type: "code",
    scope: definitions[p].scope,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...(p === "gmail"
      ? { access_type: "offline", prompt: "consent select_account" }
      : { prompt: "select_account" }),
  });
  return u.href;
}
export async function finishConnect(p, params, session) {
  if (busy) throw Error("Wait for sync to finish");
  busy = true;
  try {
    const state = params.get("state"),
      flow = pending.get(state);
    pending.delete(state);
    if (
      !flow ||
      flow.p !== p ||
      flow.session !== session ||
      flow.expires < Date.now()
    )
      throw Error("Sign-in expired or invalid; start again on this computer");
    if (params.has("error") || !params.get("code"))
      throw Error("Account permission was not granted");
    const token = await request(definitions[p].token, {
      method: "POST",
      body: tokenParams(p, {
        grant_type: "authorization_code",
        code: params.get("code"),
        redirect_uri: redirect(p),
        code_verifier: flow.verifier,
      }),
    });
    const profile = await request(
      p === "gmail"
        ? "https://gmail.googleapis.com/gmail/v1/users/me/profile"
        : "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName",
      { headers: { Authorization: `Bearer ${token.access_token}` } },
    );
    const email =
      p === "gmail"
        ? profile.emailAddress
        : profile.mail || profile.userPrincipalName;
    const id = createHash("sha256")
      .update(p + ":" + email)
      .digest("hex");
    const all = await accounts(),
      old = all.find((a) => a.id === id);
    const account = {
      id,
      provider: p,
      email,
      accessToken: token.access_token,
      refreshToken: token.refresh_token || old?.refreshToken,
      expires: Date.now() + token.expires_in * 1000,
      coverage: old?.coverage || null,
    };
    await saveAccounts([...all.filter((a) => a.id !== id), account]);
  } finally {
    busy = false;
  }
}
async function access(a) {
  if (a.expires > Date.now() + 60000) return a.accessToken;
  if (!a.refreshToken) throw Error("Reconnect this account");
  const token = await request(definitions[a.provider].token, {
    method: "POST",
    body: tokenParams(a.provider, {
      grant_type: "refresh_token",
      refresh_token: a.refreshToken,
    }),
  });
  a.accessToken = token.access_token;
  a.refreshToken = token.refresh_token || a.refreshToken;
  a.expires = Date.now() + token.expires_in * 1000;
  return a.accessToken;
}
export const syncBusy = () => busy;
export async function publicAccounts() {
  return (await accounts()).map(
    ({ id, provider, email, coverage, lastError }) => ({
      id,
      provider,
      email,
      coverage,
      lastError,
    }),
  );
}
export async function disconnect(id) {
  if (busy) throw Error("Wait for the current sync to finish");
  busy = true;
  try {
    const all = await accounts();
    await saveAccounts(all.filter((a) => a.id !== id));
    const { readdir, readFile, unlink } = await import("node:fs/promises");
    const { documents } = await import("./store.mjs");
    for (const f of await readdir(documents).catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    })) {
      if (!f.endsWith(".json")) continue;
      const r = JSON.parse(await readFile(path.join(documents, f), "utf8"));
      if (r.accountId === id) await unlink(path.join(documents, f));
    }
  } finally {
    busy = false;
  }
}
function plain(html) {
  return String(html || "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Math.min(Number(n), 0x10ffff)),
    );
}
export async function syncAccount(id, older = false) {
  if (busy) throw Error("An email sync is already running");
  busy = true;
  try {
    const all = await accounts(),
      a = all.find((a) => a.id === id);
    if (!a) throw Error("Account not found");
    let token;
    const count = { messages: 0, attachments: 0, skippedAttachments: 0 };
    try {
      token = await access(a);
      const get = (url) =>
        request(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Prefer: 'outlook.body-content-type="text"',
          },
        });
      let cursor = older ? a.coverage?.next : null;
      const gmail = a.provider === "gmail";
      const labels = new Map(),
        folders = new Map();
      if (gmail) {
        const l = await get(
          "https://gmail.googleapis.com/gmail/v1/users/me/labels",
        );
        for (const x of l.labels || []) labels.set(x.id, x.name);
      }
      const cap = 200;
      let more = false;
      async function skipped(
        name,
        base,
        key,
        note = "Content extraction is not supported for this attachment",
      ) {
        count.skippedAttachments++;
        await putRecord(`${a.id}:attachment:${key}`, {
          ...base,
          type: "attachment",
          filename: name,
          text: "",
          contentStatus: note,
        });
      }
      async function attachment(name, data, base, key) {
        if (!extensions.has(path.extname(name).toLowerCase())) {
          await skipped(name, base, key);
          return;
        }
        try {
          const text = await extract(data, name);
          await putRecord(`${a.id}:attachment:${key}`, {
            ...base,
            type: "attachment",
            filename: name,
            text,
            contentStatus: text.trim()
              ? "extracted"
              : "No text extracted; OCR may be required",
          });
          count.attachments++;
        } catch {
          await skipped(
            name,
            base,
            key,
            "Text extraction failed; search the filename or open the original email",
          );
        }
      }
      while (count.messages < cap) {
        let list;
        if (gmail) {
          const u = new URL(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages",
          );
          u.search = new URLSearchParams({
            maxResults: "25",
            includeSpamTrash: "true",
            ...(cursor ? { pageToken: cursor } : {}),
          });
          list = await get(u);
        } else {
          const first =
            "https://graph.microsoft.com/v1.0/me/messages?$top=25&$orderby=receivedDateTime%20desc&$select=id,subject,body,from,receivedDateTime,parentFolderId,webLink,hasAttachments";
          const u = cursor || first;
          if (!u.startsWith("https://graph.microsoft.com/v1.0/"))
            throw Error("Invalid continuation URL");
          list = await get(u);
        }
        for (const item of gmail ? list.messages || [] : list.value || []) {
          const m = gmail
            ? await get(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`,
              )
            : item;
          let title, text, location, timestamp, openUrl, sender;
          if (gmail) {
            const headers = new Map(
              (m.payload?.headers || []).map((h) => [
                h.name.toLowerCase(),
                h.value,
              ]),
            );
            title = headers.get("subject") || "(No subject)";
            sender = headers.get("from") || "";
            location = (m.labelIds || [])
              .map((l) => labels.get(l) || l)
              .join(" / ");
            timestamp = Math.floor(Number(m.internalDate) / 1000);
            openUrl = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(a.email)}#all/${m.id}`;
            text = "";
          } else {
            title = m.subject || "(No subject)";
            sender = m.from?.emailAddress?.address || "";
            timestamp = Math.floor(Date.parse(m.receivedDateTime) / 1000);
            openUrl = m.webLink;
            text =
              m.body?.contentType === "html"
                ? plain(m.body.content)
                : m.body?.content || "";
            if (!folders.has(m.parentFolderId)) {
              const f = await get(
                `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(m.parentFolderId)}?$select=displayName`,
              );
              folders.set(m.parentFolderId, f.displayName);
            }
            location = folders.get(m.parentFolderId);
          }
          const base = {
            source: a.provider,
            accountId: a.id,
            account: a.email,
            location: `${a.email} / ${location}`,
            timestamp,
            openUrl,
            chatId: sender,
            filename: title,
          };
          if (gmail) {
            async function walk(part, prefix = "0") {
              if (!part) return;
              if (part.filename) {
                if (
                  Number(part.body?.size) > maxBytes ||
                  !extensions.has(path.extname(part.filename).toLowerCase())
                ) {
                  await skipped(
                    part.filename,
                    base,
                    m.id + ":" + prefix,
                    Number(part.body?.size) > maxBytes
                      ? "Attachment exceeds the 20 MB content extraction limit"
                      : "Content extraction is not supported for this attachment",
                  );
                } else {
                  const body = part.body?.attachmentId
                    ? await get(
                        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
                      )
                    : part.body;
                  if (body?.data)
                    await attachment(
                      part.filename,
                      Buffer.from(body.data, "base64url"),
                      base,
                      m.id + ":" + prefix,
                    );
                }
              } else if (part.body?.data) {
                const t = Buffer.from(part.body.data, "base64url").toString(
                  "utf8",
                );
                if (part.mimeType === "text/plain") text += "\n" + t;
                else if (part.mimeType === "text/html") text += "\n" + plain(t);
              }
              for (const [i, p] of (part.parts || []).entries())
                await walk(p, prefix + "." + i);
            }
            await walk(m.payload);
          } else if (m.hasAttachments) {
            let next = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(m.id)}/attachments`;
            do {
              if (!next.startsWith("https://graph.microsoft.com/v1.0/"))
                throw Error("Invalid attachment continuation");
              const ats = await get(next);
              for (const at of ats.value || []) {
                if (at.size > maxBytes || !at.contentBytes) {
                  await skipped(
                    at.name,
                    base,
                    m.id + ":" + at.id,
                    "Content is unavailable or exceeds the 20 MB extraction limit",
                  );
                  continue;
                }
                await attachment(
                  at.name,
                  Buffer.from(at.contentBytes, "base64"),
                  base,
                  m.id + ":" + at.id,
                );
              }
              next = ats["@odata.nextLink"];
            } while (next);
          }
          await putRecord(`${a.id}:message:${m.id}`, {
            ...base,
            type: "email",
            text: title + "\n" + sender + "\n" + text,
          });
          count.messages++;
        }
        cursor = gmail ? list.nextPageToken : list["@odata.nextLink"];
        if (!cursor) break;
      }
      more = Boolean(cursor);
      a.coverage = {
        ...count,
        updatedAt: Date.now(),
        next: cursor || null,
        partial: more,
        mode: older ? "older page" : "newest page",
        note: more
          ? "More mail remains. Continue older mail to expand coverage."
          : "Reached the end of this scan. Cached deletions are not reconciled.",
      };
      delete a.lastError;
      await saveAccounts(all);
      return a.coverage;
    } catch (e) {
      a.lastError = e.message;
      await saveAccounts(all);
      throw e;
    }
  } finally {
    busy = false;
  }
}
