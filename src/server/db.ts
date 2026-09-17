// Centralized Turso access. Server-only: never import from client components.
import { createClient, type Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let singleton: Client | null = null;
let schemaReady = false;

function schemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "schema.sql"), "utf8");
}

/** Split schema into single statements (schema contains no triggers/procedures). */
export function splitStatements(sql: string): string[] {
  // Strip -- line comments first: they may contain semicolons.
  const stripped = sql.replace(/--[^\n]*/g, "");
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Create the ko_ schema idempotently on the given client. */
export async function ensureSchema(client: Client): Promise<void> {
  for (const stmt of splitStatements(schemaSql())) {
    await client.execute(stmt);
  }
  // Some drivers need explicit FK enforcement per connection.
  try {
    await client.execute("PRAGMA foreign_keys = ON");
  } catch {
    // Remote Turso ignores PRAGMA; cascade still enforced server-side.
  }
}

/** Isolated client for tests/tools: file DB or explicit URL. */
export function createIsolatedClient(url: string): Client {
  return createClient({ url });
}

function configError(): Error {
  return new Error(
    "Missing Turso configuration: set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN for remote databases).",
  );
}

/** Shared client from server runtime env (process.env for Vercel, .env files in dev). */
export function getClient(): Client {
  if (singleton) return singleton;
  const url = process.env["TURSO_DATABASE_URL"];
  const authToken = process.env["TURSO_AUTH_TOKEN"];
  if (!url) throw configError();
  singleton =
    url.startsWith("file:") || url === ":memory:"
      ? createClient({ url })
      : createClient({ url, authToken });
  return singleton;
}

/** Shared client + lazy schema init (safe to call per request). */
export async function getReadyClient(): Promise<Client> {
  const client = getClient();
  if (!schemaReady) {
    await ensureSchema(client);
    schemaReady = true;
  }
  return client;
}

/** Test hook: reset module singleton between isolated runs. */
export function __resetClientForTests(): void {
  singleton = null;
  schemaReady = false;
}
