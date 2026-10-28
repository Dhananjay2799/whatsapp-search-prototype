import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderRequest, gmailCost } from "../lib/provider-request.mjs";
const url =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/abc?format=full";
const limited = () =>
  new Response(
    JSON.stringify({ error: { details: [{ reason: "RATE_LIMIT_EXCEEDED" }] } }),
    { status: 403 },
  );
test("Gmail request costs and pacing account for full messages and attachments", async () => {
  assert.equal(gmailCost(url), 60);
  assert.equal(
    gmailCost(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/a/attachments/b",
    ),
    20,
  );
  let clock = 1000;
  const waits = [];
  const req = createProviderRequest({
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    fetcher: async () => new Response("{}"),
  });
  await req(url);
  await req(url);
  assert.equal(waits[0], 800);
});
test("403 quota responses retry after backoff and honor Retry-After", async () => {
  let calls = 0,
    clock = 0;
  const waits = [];
  const req = createProviderRequest({
    now: () => clock,
    random: () => 0,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    fetcher: async () => {
      calls++;
      return calls === 1
        ? new Response(
            JSON.stringify({
              error: { details: [{ reason: "RATE_LIMIT_EXCEEDED" }] },
            }),
            { status: 403, headers: { "retry-after": "5" } },
          )
        : new Response('{"ok":true}');
    },
  });
  assert.deepEqual(await req(url), { ok: true });
  assert.equal(calls, 2);
  assert.ok(waits.includes(5000));
});
test("retries are bounded and permission failures are not retried", async () => {
  let calls = 0;
  const req = createProviderRequest({
    wait: async () => {},
    random: () => 0,
    fetcher: async () => {
      calls++;
      return limited();
    },
  });
  await assert.rejects(req(url), /RATE_LIMIT_EXCEEDED/);
  assert.equal(calls, 7);
  calls = 0;
  const forbidden = createProviderRequest({
    wait: async () => {},
    fetcher: async () => {
      calls++;
      return new Response(
        JSON.stringify({
          error: { errors: [{ reason: "insufficientPermissions" }] },
        }),
        { status: 403 },
      );
    },
  });
  await assert.rejects(forbidden(url), /Reconnect Gmail/);
  assert.equal(calls, 1);
});
