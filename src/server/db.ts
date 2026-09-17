// Centralized Turso access. Server-only: never import from client components.
import { createClient, type Client } from "@libsql/client";
// Bundled at build time so the Vercel server output needs no schema.sql file.
import schema from "./schema.sql?raw";

let singleton: Client | null = null;
let schemaReady = false;

function schemaSql(): string {
  return schema;
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

interface ViteEnv {
  DEV?: boolean;
  MODE?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
}

/**
 * Resolve Turso config: runtime process.env wins (Vercel, tools, tests).
 * Dev-only fallback to Vite-loaded env (.env.development.local), which Astro
 * exposes via import.meta.env instead of process.env. Production never uses
 * build-time env, so no secret is injected into or leaked from the bundle.
 */
export function resolveDatabaseConfig(
  processEnv: NodeJS.ProcessEnv = process.env,
  viteEnv: ViteEnv = import.meta.env as unknown as ViteEnv,
): { url: string | undefined; authToken: string | undefined } {
  const dev = viteEnv.DEV === true;
  const url =
    processEnv["TURSO_DATABASE_URL"] ?? (dev ? viteEnv.TURSO_DATABASE_URL : undefined);
  const authToken =
    processEnv["TURSO_AUTH_TOKEN"] ?? (dev ? viteEnv.TURSO_AUTH_TOKEN : undefined);
  return { url, authToken };
}

/** Shared client from server runtime env (process.env for Vercel, .env files in dev). */
export function getClient(): Client {
  if (singleton) return singleton;
  const { url, authToken } = resolveDatabaseConfig();
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
