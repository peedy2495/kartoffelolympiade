import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Idempotent migration: only creates ko_ tables / settings row, never destructive.
// Usage: node --env-file=.env.development.local scripts/migrate.mjs
// Never prints secret values.

const url = process.env["TURSO_DATABASE_URL"];
const authToken = process.env["TURSO_AUTH_TOKEN"];

if (!url) {
  console.error(
    "Missing TURSO_DATABASE_URL. Copy .env.example to .env.development.local or set env vars.",
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, "..", "src", "server", "schema.sql"), "utf8");

const client =
  url.startsWith("file:") || url === ":memory:"
    ? createClient({ url })
    : createClient({ url, authToken });

try {
  // Non-destructive connectivity check (no test rows written).
  await client.execute("SELECT 1");
  const stripped = schema.replace(/--[^\n]*/g, "");
  for (const stmt of stripped.split(";").map((s) => s.trim()).filter(Boolean)) {
    await client.execute(stmt);
  }
  try {
    await client.execute("PRAGMA foreign_keys = ON");
  } catch {
    // Remote Turso ignores PRAGMA.
  }
  console.log("Migration ok: connectivity verified, ko_ schema ensured.");
} catch (e) {
  console.error("Migration failed:", e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  client.close();
}
