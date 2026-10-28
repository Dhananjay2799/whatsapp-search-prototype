const $ = (s) => document.querySelector(s);
let latest = [],
  lastStatus = null,
  queryVersion = 0;
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
async function api(url, body) {
  const r = await fetch(
    url,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await r.json();
  if (r.status === 401) {
    $("#login").hidden = false;
    $("#workspace").hidden = true;
    $("#logout").hidden = true;
  }
  if (!r.ok) throw Error(data.error || "Request failed");
  return data;
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/login", { key: $("#key").value });
    $("#key").value = "";
    $("#login-status").textContent = "";
    await refresh();
  } catch (e) {
    $("#login-status").textContent = e.message;
  }
});
$("#logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", {});
  } finally {
    latest = [];
    $("#results").replaceChildren();
    $("#query").value = "";
    $("#login").hidden = false;
    $("#workspace").hidden = true;
    $("#logout").hidden = true;
  }
});
function render() {
  const matches = latest.filter(
    (r) =>
      ($("#source").value === "all" || r.source === $("#source").value) &&
      ($("#type").value === "all" || r.type === $("#type").value),
  );
  $("#results").replaceChildren();
  $("#search-status").textContent =
    `${matches.length} displayed${lastStatus?.limited ? " · Result limit reached; narrow your search" : ""}. Indexed content only.`;
  for (const r of matches) {
    const c = el("article", null, "card");
    c.append(
      el("span", r.source + " · " + r.type, "tag"),
      el("h3", r.filename),
      el("div", r.location, "meta"),
      el(
        "div",
        r.timestamp
          ? new Date(r.timestamp * 1000).toLocaleString()
          : "Date unknown",
        "meta",
      ),
      el("p", r.excerpt, "excerpt"),
    );
    if (r.contentStatus && r.contentStatus !== "extracted")
      c.append(el("p", r.contentStatus, "meta"));
    const href = r.pdf ? "/pdf/" + encodeURIComponent(r.pdf) : r.openUrl;
    if (href) {
      const a = el("a", r.pdf ? "Open saved PDF" : "Open original email");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      c.append(a);
    }
    $("#results").append(c);
  }
}
$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = ++queryVersion;
  $("#search-status").textContent = "Searching…";
  try {
    const d = await api(
      "/api/search?q=" +
        encodeURIComponent($("#query").value.trim()) +
        "&source=" +
        encodeURIComponent($("#source").value),
    );
    if (v !== queryVersion) return;
    latest = d.results;
    lastStatus = d;
    render();
  } catch (e) {
    $("#search-status").textContent = e.message;
  }
});
$("#source").addEventListener("change", () => {
  if ($("#query").value.trim()) $("#search-form").requestSubmit();
});
$("#type").addEventListener("change", render);
async function action(fn) {
  try {
    $("#connection-status").textContent = "Working…";
    await fn();
    $("#connection-status").textContent = "";
    await refresh();
  } catch (e) {
    $("#connection-status").textContent = e.message;
  }
}
for (const b of document.querySelectorAll("[data-connect]"))
  b.addEventListener("click", () =>
    action(async () => {
      const d = await api("/api/connect/" + b.dataset.connect, {});
      location.assign(d.url);
    }),
  );
async function refresh() {
  try {
    const d = await api("/api/status");
    $("#login").hidden = true;
    $("#workspace").hidden = false;
    $("#logout").hidden = false;
    $("#whatsapp-state").textContent =
      d.state === "offline" ? "Not running" : d.state;
    for (const p of ["gmail", "outlook"]) {
      $("#" + p + "-config").textContent = d.configured[p]
        ? "Ready to connect"
        : "Setup needed";
      const b = document.querySelector('[data-connect="' + p + '"]');
      b.disabled = !d.configured[p] || !d.local || d.syncing;
      b.title = !d.local ? "Connect accounts on your computer" : "";
    }
    $("#accounts").replaceChildren();
    for (const a of d.accounts) {
      const c = el("article", null, "account");
      c.append(el("strong", a.provider + " · " + a.email));
      const cov = a.coverage;
      c.append(
        el(
          "p",
          cov
            ? `Last scan: ${new Date(cov.updatedAt).toLocaleString()} · ${cov.messages} messages · ${cov.attachments} attachments · ${cov.skippedAttachments} attachments skipped. ${cov.note}`
            : "Connected. Sync this account to make email searchable.",
        ),
      );
      if (a.lastError) c.append(el("p", a.lastError));
      for (const [label, older] of [
        ["Sync latest", false],
        ["Continue older mail", true],
      ]) {
        if (older && !cov?.next) continue;
        const b = el("button", d.syncing ? "Sync running…" : label);
        b.disabled = d.syncing;
        b.addEventListener("click", () =>
          action(() => api("/api/sync", { id: a.id, older })),
        );
        c.append(b);
      }
      const b = el("button", "Disconnect & remove indexed email", "quiet");
      b.disabled = d.syncing;
      b.addEventListener("click", () =>
        action(async () => {
          await api("/api/disconnect", { id: a.id });
          latest = latest.filter(
            (r) => r.account !== a.email || r.source !== a.provider,
          );
          render();
        }),
      );
      c.append(b);
      $("#accounts").append(c);
    }
  } catch (e) {
    if (!$("#workspace").hidden)
      $("#connection-status").textContent = e.message;
  }
}
refresh();
setInterval(refresh, 10000);
