// Built mutation smoke: exercise the ACTUAL Vercel build output through the
// INSTALLED NodeApp.createRequest normalization using the ACTUAL built
// manifest allowedDomains (never source config or a hardcoded allowlist).
//
// Flow per mutation: fake Vercel-style Node request (host + x-forwarded-host
// + x-forwarded-proto) -> NodeApp.createRequest with built allowedDomains ->
// real Request with browser Origin + JSON body -> built bundle page.ALL.
// Isolated file DB below artifacts/test; start + stop collection, create one
// supervisor, confirm persisted state. Logs statuses and row counts only
// (never tokens or names). Cleans up only its own DB files.
//
// Usage:
//   node scripts/smoke-built-mutations.mjs [--bundle <path>]
import { EventEmitter } from "node:events";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeApp } from "astro/app/node";

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
const manifestDir = resolve(repo, ".vercel/output/functions/_render.func/dist/server");
const dbFile = join(repo, "artifacts", "test", `built-mutations-${process.pid}.db`);

const PROD_HOST = "kartoffelolympiade.vercel.app";
const PROD_ORIGIN = `https://${PROD_HOST}`;

function cleanup() {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      rmSync(`${dbFile}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
}

let failed = false;
function report(label, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
}

try {
  // Actual built manifest allowedDomains (glob tolerates the hashed name).
  const manifestName = readdirSync(manifestDir).find(
    (f) => f.startsWith("manifest_") && f.endsWith(".mjs"),
  );
  if (!manifestName) throw new Error("built manifest not found");
  const { manifest } = await import(join(manifestDir, manifestName));
  const allowedDomains = manifest?.allowedDomains ?? [];
  report(
    "built manifest carries production allowlist",
    allowedDomains.some(
      (d) => d.hostname === PROD_HOST && d.protocol === "https",
    ),
    `entries=${allowedDomains.length}`,
  );

  // Vercel-style Node request through the installed normalizer.
  const fake = {
    method: "POST",
    url: "/api/gamemaster/collection",
    headers: {
      host: PROD_HOST,
      "x-forwarded-host": PROD_HOST,
      "x-forwarded-proto": "https",
      origin: PROD_ORIGIN,
    },
    socket: new EventEmitter(),
  };
  const normalized = new URL(
    NodeApp.createRequest(fake, { skipBody: true, allowedDomains }).url,
  );
  report("normalized origin keeps public host", normalized.origin === PROD_ORIGIN, normalized.origin);

  cleanup();
  process.env["TURSO_DATABASE_URL"] = `file:${dbFile}`;
  delete process.env["TURSO_AUTH_TOKEN"];

  const mod = await import(bundle);
  const route = typeof mod.page === "function" ? mod.page() : mod.page;
  if (!route || typeof route.ALL !== "function") throw new Error("built bundle has no page.ALL");

  async function mutation(path, origin, body, method = "POST") {
    const req = new Request(new URL(path, normalized.origin), {
      method,
      headers: { origin, "content-type": "application/json" },
      body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
    });
    const res = await route.ALL({ request: req });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  const start = await mutation("/api/gamemaster/collection", PROD_ORIGIN, { open: true });
  report("start collection via built bundle", start.status === 200, `HTTP ${start.status}`);

  const created = await mutation("/api/gamemaster/supervisors", PROD_ORIGIN, {
    name: "Smoke Supervisor",
  });
  report("create supervisor via built bundle", created.status === 201, `HTTP ${created.status}`);

  const foreign = await mutation("/api/gamemaster/collection", "https://evil.example", {
    open: false,
  });
  report("foreign Origin still rejected", foreign.status === 403, `HTTP ${foreign.status}`);

  const stop = await mutation("/api/gamemaster/collection", PROD_ORIGIN, { open: false });
  report("stop collection via built bundle", stop.status === 200, `HTTP ${stop.status}`);

  const stateRes = await route.ALL({
    request: new Request(new URL("/api/gamemaster/state", normalized.origin)),
  });
  const state = await stateRes.json().catch(() => ({}));
  const persisted =
    stateRes.status === 200 &&
    state.collectionOpen === false &&
    Array.isArray(state.supervisors) &&
    state.supervisors.length === 1;
  report(
    "persisted state confirmed (counts only)",
    persisted,
    `HTTP ${stateRes.status} supervisors=${Array.isArray(state.supervisors) ? state.supervisors.length : "?"}`,
  );
} catch (e) {
  console.error(`SMOKE ERROR ${e instanceof Error ? e.message : e}`);
  failed = true;
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
