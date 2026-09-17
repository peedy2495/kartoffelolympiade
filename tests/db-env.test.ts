import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadEnv } from "vite";
import { createClient } from "@libsql/client";
import {
  __resetClientForTests,
  ensureSchema,
  resolveDatabaseConfig,
} from "../src/server/db.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "artifacts", "test", "loadenv-fixture");

function writeFixture() {
  mkdirSync(fixtureDir, { recursive: true });
  // Placeholder values only; never real credentials.
  writeFileSync(
    join(fixtureDir, ".env.development"),
    "KO_FIXTURE_PROBE_URL=file:./fixture-placeholder.db\n",
  );
}

describe("dev env loading (regression: Astro dev 500 without inherited TURSO vars)", () => {
  it("vite loads .env.development outside process.env (the Astro dev mechanism)", () => {
    writeFixture();
    delete process.env["KO_FIXTURE_PROBE_URL"];
    // Empty prefix: Astro exposes all server-side vars (not just VITE_).
    const loaded = loadEnv("development", fixtureDir, "");
    expect(process.env["KO_FIXTURE_PROBE_URL"]).toBeUndefined();
    expect(loaded["KO_FIXTURE_PROBE_URL"]).toBe("file:./fixture-placeholder.db");
  });

  it("resolves TURSO url from vite dev env when process env is empty", () => {
    __resetClientForTests();
    const cfg = resolveDatabaseConfig(
      {},
      { DEV: true, TURSO_DATABASE_URL: "file:./dev-fallback.db" },
    );
    expect(cfg.url).toBe("file:./dev-fallback.db");
  });

  it("prefers process.env over vite dev env", () => {
    __resetClientForTests();
    const cfg = resolveDatabaseConfig(
      { TURSO_DATABASE_URL: "file:./from-process.db" },
      { DEV: true, TURSO_DATABASE_URL: "file:./from-vite.db" },
    );
    expect(cfg.url).toBe("file:./from-process.db");
  });

  it("production ignores vite env fallback (runtime env only, no build-time secrets)", () => {
    __resetClientForTests();
    const cfg = resolveDatabaseConfig(
      {},
      { DEV: false, MODE: "production", TURSO_DATABASE_URL: "file:./should-not-leak.db" },
    );
    expect(cfg.url).toBeUndefined();
  });

  it("bundled schema initializes an isolated file DB without data changes", async () => {
    const dir = join(here, "..", "artifacts", "test");
    mkdirSync(dir, { recursive: true });
    const client = createClient({ url: `file:${join(dir, `env-${randomUUID()}.db`)}` });
    try {
      await ensureSchema(client);
      const rows = await client.execute("SELECT value FROM ko_settings WHERE key='collection_open'");
      expect(rows.rows.length).toBe(1);
    } finally {
      client.close();
    }
  });
});
