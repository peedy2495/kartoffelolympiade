// Regression: Vercel-style requests must survive Astro's trusted-host
// normalization so the API's same-origin check accepts gamemaster POSTs.
// Uses the INSTALLED NodeApp.createRequest with the CURRENT astro config
// allowedDomains (not a handcrafted Request URL), then routes mutations
// through the real dispatcher against an isolated file DB.
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeApp } from "astro/app/node";
import { __resetClientForTests } from "../src/server/db.ts";
import { ALL } from "../src/pages/api/[...path].ts";

const PROD_HOST = "kartoffelolympiade.vercel.app";
const PROD_ORIGIN = `https://${PROD_HOST}`;

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "artifacts", "test");

interface FakeSocketReq {
  method: string;
  url: string;
  headers: Record<string, string>;
  socket: EventEmitter;
}

// Read the ACTUAL astro config so missing wiring is caught by the test.
async function configuredDomains(): Promise<Array<{ hostname?: string; protocol?: string; port?: string }>> {
  const mod = (await import("../astro.config.mjs")) as {
    default: { security?: { allowedDomains?: Array<{ hostname?: string; protocol?: string; port?: string }> } };
  };
  return mod.default.security?.allowedDomains ?? [];
}

/** Vercel-style Node request: plain http socket + forwarded https host. */
function vercelStyleRequest(path: string, origin: string): FakeSocketReq {
  return {
    method: "POST",
    url: path,
    headers: {
      host: PROD_HOST,
      "x-forwarded-host": PROD_HOST,
      "x-forwarded-proto": "https",
      origin,
    },
    socket: new EventEmitter(),
  };
}

function normalizedUrl(req: FakeSocketReq, allowedDomains: unknown[]): URL {
  const request = NodeApp.createRequest(req as never, {
    skipBody: true,
    allowedDomains: allowedDomains as never,
  }) as unknown as Request;
  return new URL(request.url);
}

/** Route a mutation through the real dispatcher using the normalized URL. */
async function dispatchMutation(
  normalized: URL,
  path: string,
  origin: string,
  body: unknown,
  method = "POST",
) {
  const req = new Request(new URL(path, normalized.origin), {
    method,
    headers: { origin, "content-type": "application/json" },
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
  return ALL({ request: req } as never) as Promise<Response>;
}

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
});

afterAll(() => {
  try {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        rmSync(join(dir, `vercel-origin-${process.pid}.db${suffix}`), { force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
});

function useIsolatedDb(): void {
  const dbFile = join(dir, `vercel-origin-${process.pid}.db`);
  process.env["TURSO_DATABASE_URL"] = `file:${dbFile}`;
  delete process.env["TURSO_AUTH_TOKEN"];
  __resetClientForTests();
  try {
    writeFileSync(join(dir, ".gitignore"), "*\n!.gitignore\n");
  } catch {
    /* ignore */
  }
}

describe("vercel request normalization (NodeApp + current astro config)", () => {
  it("normalizes a Vercel-style request to the public https origin", async () => {
    const allowedDomains = await configuredDomains();
    const url = normalizedUrl(
      vercelStyleRequest("/api/gamemaster/collection", PROD_ORIGIN),
      allowedDomains,
    );
    expect(url.origin).toBe(PROD_ORIGIN);
  });

  it("collection start/stop succeed with browser Origin header", async () => {
    useIsolatedDb();
    const allowedDomains = await configuredDomains();
    const normalized = normalizedUrl(
      vercelStyleRequest("/api/gamemaster/collection", PROD_ORIGIN),
      allowedDomains,
    );
    expect(normalized.origin).toBe(PROD_ORIGIN);
    const start = await dispatchMutation(normalized, "/api/gamemaster/collection", PROD_ORIGIN, {
      open: true,
    });
    expect(start.status).toBe(200);
    const stop = await dispatchMutation(normalized, "/api/gamemaster/collection", PROD_ORIGIN, {
      open: false,
    });
    expect(stop.status).toBe(200);
    expect((await stop.json()) as { collectionOpen: boolean }).toEqual({
      collectionOpen: false,
    });
  });

  it("supervisor creation succeeds with browser Origin header", async () => {
    useIsolatedDb();
    const allowedDomains = await configuredDomains();
    const normalized = normalizedUrl(
      vercelStyleRequest("/api/gamemaster/supervisors", PROD_ORIGIN),
      allowedDomains,
    );
    expect(normalized.origin).toBe(PROD_ORIGIN);
    const res = await dispatchMutation(
      normalized,
      "/api/gamemaster/supervisors",
      PROD_ORIGIN,
      { name: `Reg Test ${randomUUID().slice(0, 8)}` },
    );
    expect(res.status).toBe(201);
  });

  it("foreign Origin is still rejected", async () => {
    useIsolatedDb();
    const allowedDomains = await configuredDomains();
    const normalized = normalizedUrl(
      vercelStyleRequest("/api/gamemaster/collection", PROD_ORIGIN),
      allowedDomains,
    );
    const res = await dispatchMutation(
      normalized,
      "/api/gamemaster/collection",
      "https://evil.example",
      { open: true },
    );
    expect(res.status).toBe(403);
  });

  it("unknown forwarded host is not trusted", async () => {
    const allowedDomains = await configuredDomains();
    const url = normalizedUrl(
      {
        method: "POST",
        url: "/api/gamemaster/collection",
        headers: {
          host: "unknown.example",
          "x-forwarded-host": "unknown.example",
          "x-forwarded-proto": "https",
          origin: "https://unknown.example",
        },
        socket: new EventEmitter(),
      },
      allowedDomains,
    );
    // Falls back to localhost: the foreign host must not be adopted.
    expect(url.origin).not.toBe("https://unknown.example");
  });
});
