// Dev smoke: ordinary `astro dev` with inherited TURSO_* vars UNSET, so the
// server must load .env.development.local via Vite (real local credentials).
// Read-only: GET state only, never creates/edits/deletes rows.
// Prints only HTTP statuses and row counts (never tokens or names).
//
// Usage:
//   node scripts/smoke-dev.mjs [--port 4333] [--path /api/gamemaster/state]
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = Number(opt("--port", "4333"));
const apiPath = opt("--path", "/api/gamemaster/state");
const BASE = `http://127.0.0.1:${PORT}`;

function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("dev server start timeout")), 90000);
    const onData = (d) => {
      if (/ready|Local/i.test(String(d))) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`dev server exited early with code ${code}`));
    });
  });
}

async function waitHttpOk(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.status) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server not reachable at ${url}`);
}

let server = null;
let failed = false;
try {
  const childEnv = { ...process.env };
  delete childEnv["TURSO_DATABASE_URL"];
  delete childEnv["TURSO_AUTH_TOKEN"];
  console.log("Dev smoke: inherited TURSO_* unset; server must use .env.development.local.");
  server = spawn("npx", ["astro", "dev", "--port", String(PORT), "--host", "127.0.0.1"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = waitForServer(server).catch(() => {});
  await waitHttpOk(`${BASE}/`);
  await ready;
  const res = await fetch(`${BASE}${apiPath}`);
  const body = await res.json().catch(() => ({}));
  const counts =
    res.ok && body && typeof body === "object"
      ? ` participants=${Array.isArray(body.participants) ? body.participants.length : "?"} supervisors=${Array.isArray(body.supervisors) ? body.supervisors.length : "?"}`
      : "";
  console.log(`GET ${apiPath} -> HTTP ${res.status}${counts}`);
  if (res.status !== 200) failed = true;
} catch (e) {
  console.error(`SMOKE ERROR: ${e instanceof Error ? e.message : e}`);
  failed = true;
} finally {
  if (server) {
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    try {
      server.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}
process.exit(failed ? 1 : 0);
