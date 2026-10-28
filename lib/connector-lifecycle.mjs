import net from "node:net";
import { createHash } from "node:crypto";

// A loopback listener is released by the OS even after a crash; no stale lock files.
export async function acquireConnectorLock(projectPath) {
  const port =
    42000 +
    (createHash("sha256").update(projectPath).digest().readUInt16BE(0) % 18000);
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  }).catch((error) => {
    if (error.code === "EADDRINUSE") {
      throw new Error(
        "A WhatsApp connector is already running for this project (or its local guard port is occupied). Stop the earlier connector before starting another.",
      );
    }
    throw error;
  });
  server.unref();
  return () =>
    new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
}

export function disconnectAction(status, reasons) {
  if (status === reasons.connectionReplaced) return "replaced";
  if (
    status === reasons.loggedOut ||
    status === reasons.badSession ||
    status === reasons.forbidden ||
    status === reasons.multideviceMismatch
  )
    return "stop";
  return "retry";
}
