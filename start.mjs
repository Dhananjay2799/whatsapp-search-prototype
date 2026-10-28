import { spawn } from "node:child_process";
import { root } from "./lib/store.mjs";
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  process.exitCode = code;
}
for (const file of ["server.mjs", "index.mjs"]) {
  const c = spawn(process.execPath, [file], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, INDEX_MESSAGES: process.env.INDEX_MESSAGES ?? "1" },
  });
  children.push(c);
  c.on("error", (e) => {
    console.error(e.message);
    stop(1);
  });
  c.on("exit", (code) => {
    if (!stopping) stop(code || 0);
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
