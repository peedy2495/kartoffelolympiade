// Production smoke: invoke the ACTUAL built API bundle with an isolated
// file DB via runtime process.env. Proves schema.sql is packaged server-side.
// Read-only: GET state only, never writes participants/supervisors/settings.
// Prints only HTTP statuses and row counts (never tokens or names).
//
// Usage:
//   node scripts/smoke-built-api.mjs [--bundle <path>] [--path /api/gamemaster/state]
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const bundle = resolve(
  repo,
  opt(
    "--bundle",
    ".vercel/output/functions/_render.func/dist/server/pages/api/_---path_.astro.mjs",
  ),
);
const apiPath = opt("--path", "/api/gamemaster/state");
const dbFile = join(repo, "artifacts", "test", `built-smoke-${process.pid}.db`);

function cleanup() {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      rmSync(`${dbFile}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
}

cleanup();
process.env["TURSO_DATABASE_URL"] = `file:${dbFile}`;
delete process.env["TURSO_AUTH_TOKEN"];

let failed = false;
try {
  const mod = await import(bundle);
  const route = typeof mod.page === "function" ? mod.page() : mod.page;
  if (!route || typeof route.ALL !== "function") throw new Error("built bundle has no page.ALL");
  const res = await route.ALL({ request: new Request(`http://localhost${apiPath}`) });
  const body = await res.json().catch(() => ({}));
  const counts =
    res.ok && body && typeof body === "object"
      ? ` participants=${Array.isArray(body.participants) ? body.participants.length : "?"} supervisors=${Array.isArray(body.supervisors) ? body.supervisors.length : "?"}`
      : "";
  console.log(`GET ${apiPath} -> HTTP ${res.status}${counts}`);
  if (res.status >= 500) failed = true;
} catch (e) {
  console.error(`GET ${apiPath} -> ERROR ${e instanceof Error ? e.message : e}`);
  failed = true;
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
