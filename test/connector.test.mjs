import { test } from "node:test";
import assert from "node:assert/strict";
import { DisconnectReason } from "baileys";
import {
  acquireConnectorLock,
  disconnectAction,
} from "../lib/connector-lifecycle.mjs";
test("replaced and unauthorized sessions stop instead of reconnecting forever", () => {
  assert.equal(disconnectAction(440, DisconnectReason), "replaced");
  assert.equal(
    disconnectAction(DisconnectReason.loggedOut, DisconnectReason),
    "stop",
  );
  assert.equal(
    disconnectAction(DisconnectReason.badSession, DisconnectReason),
    "stop",
  );
  assert.equal(
    disconnectAction(DisconnectReason.connectionLost, DisconnectReason),
    "retry",
  );
  assert.equal(
    disconnectAction(DisconnectReason.restartRequired, DisconnectReason),
    "retry",
  );
});
test("a second connector is rejected and the guard can be reused after shutdown", async () => {
  const key = "connector-test-" + process.pid;
  const release = await acquireConnectorLock(key);
  try {
    await assert.rejects(acquireConnectorLock(key), /already running/);
  } finally {
    await release();
  }
  const releaseAgain = await acquireConnectorLock(key);
  await releaseAgain();
});
