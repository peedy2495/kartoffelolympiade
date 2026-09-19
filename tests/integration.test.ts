import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { ensureSchema } from "../src/server/db.ts";
import { isForeignOrigin, isJsonContentType } from "../src/server/http.ts";
import {
  ServiceError,
  adminCreateSupervisor,
  adminDeleteParticipant,
  adminDeleteSupervisor,
  adminGetInvite,
  adminGetState,
  adminReopen,
  adminSetCollection,
  supervisorCreateParticipant,
  supervisorFinalize,
  supervisorGetState,
  supervisorPatchParticipant,
} from "../src/server/service.ts";
import { findParticipant, findResultsForParticipant } from "../src/server/repository.ts";

let client: Client;
let dir: string;

async function freshClient(): Promise<Client> {
  const c = createClient({ url: `file:${join(dir, `t-${randomUUID()}.db`)}` });
  await ensureSchema(c);
  return c;
}

beforeAll(async () => {
  // Repository-local isolated file DBs (never /tmp, never live Turso data).
  const here = dirname(fileURLToPath(import.meta.url));
  dir = join(here, "..", "artifacts", "test");
  mkdirSync(dir, { recursive: true });
  client = await freshClient();
});

afterAll(() => {
  client.close();
  // Clean up isolated test DB files (keep directory).
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "*\n!.gitignore\n");
  } catch {
    // best-effort cleanup only
  }
});

async function setupTwoSupervisors(c: Client) {
  await adminSetCollection(true, c);
  const a = await adminCreateSupervisor("Anna Aufsicht", c);
  const b = await adminCreateSupervisor("Ben Aufsicht", c);
  return { a, b };
}

async function expectCode(p: Promise<unknown>, status: number, code: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).status).toBe(status);
    expect((e as ServiceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${status}/${code}, got success`);
}

describe("migrations", () => {
  it("are idempotent", async () => {
    await ensureSchema(client);
    await ensureSchema(client);
    const state = await adminGetState(client);
    expect(state.collectionOpen).toBe(false);
  });

  it("adds ko_run_details over an old schema preserving values with default 0 errors", async () => {
    const c = createClient({ url: `file:${join(dir, `t-${randomUUID()}.db`)}` });
    try {
      // Old schema without ko_run_details + existing participant/result.
      for (const stmt of [
        "CREATE TABLE ko_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        "INSERT INTO ko_settings (key, value) VALUES ('collection_open', '1')",
        "CREATE TABLE ko_supervisors (id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT UNIQUE, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)",
        "CREATE TABLE ko_participants (id TEXT PRIMARY KEY, name TEXT NOT NULL, age_group TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finalized_at TEXT)",
        "CREATE TABLE ko_results (participant_id TEXT NOT NULL, discipline TEXT NOT NULL, value INTEGER NOT NULL, supervisor_id TEXT, supervisor_name TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (participant_id, discipline))",
      ]) {
        await c.execute(stmt);
      }
      const id = randomUUID();
      await c.execute({
        sql: "INSERT INTO ko_participants (id, name, age_group, status, revision, created_at, updated_at, finalized_at) VALUES (?, 'Alte Person', 'up_to_14', 'finalized', 4, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        args: [id],
      });
      await c.execute({
        sql: "INSERT INTO ko_results (participant_id, discipline, value, supervisor_id, supervisor_name, updated_at) VALUES (?, 'obstacle', 123, 's1', 'Anna', '2026-01-01T00:00:00Z')",
        args: [id],
      });
      await ensureSchema(c);
      await ensureSchema(c); // idempotent over the old fixture
      const p = await findParticipant(c, id);
      expect(p?.name).toBe("Alte Person");
      expect(p?.status).toBe("finalized");
      expect(p?.runErrors).toBe(0); // missing row means 0
      const res = await findResultsForParticipant(c, id);
      expect(res.obstacle?.value).toBe(123);
      expect(res.obstacle?.supervisorName).toBe("Anna");
    } finally {
      c.close();
    }
  });
});

describe("shared drafts + attribution", () => {
  it("two supervisors share a draft with distinct per-discipline attribution", async () => {
    const c = await freshClient();
    try {
      const { a, b } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await supervisorCreateParticipant(
        a.token,
        { id, name: "Lina", age_group: "up_to_14" },
        c,
      );
      // Same-UUID retry is idempotent.
      const again = await supervisorCreateParticipant(
        a.token,
        { id, name: "Lina", age_group: "up_to_14" },
        c,
      );
      expect(again.id).toBe(id);
      await supervisorPatchParticipant(a.token, id, { revision: 1, results: { golf: 3 } }, c);
      const afterA = await supervisorGetState(a.token, c);
      const recA = afterA.participants.find((p) => p.id === id);
      expect(recA?.revision).toBe(2);
      // Second supervisor sees the shared draft and edits another discipline.
      const seenByB = await supervisorGetState(b.token, c);
      expect(seenByB.participants.some((p) => p.id === id)).toBe(true);
      await supervisorPatchParticipant(b.token, id, { revision: 2, results: { throwing: 5 } }, c);
      const results = await findResultsForParticipant(c, id);
      expect(results.golf?.value).toBe(3);
      expect(results.golf?.supervisorName).toBe("Anna Aufsicht");
      expect(results.throwing?.value).toBe(5);
      expect(results.throwing?.supervisorName).toBe("Ben Aufsicht");
    } finally {
      c.close();
    }
  });

  it("stale revision conflicts without lost update", async () => {
    const c = await freshClient();
    try {
      const { a, b } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await supervisorCreateParticipant(a.token, { id, name: "Tom", age_group: "over_14" }, c);
      await expectCode(
        supervisorPatchParticipant(a.token, id, { revision: 99, results: { golf: 2 } }, c),
        409,
        "STALE",
      );
      // Concurrent writers: A saves rev1->rev2, B's rev1 write must fail, not overwrite.
      await supervisorPatchParticipant(a.token, id, { revision: 1, results: { golf: 2 } }, c);
      await expectCode(
        supervisorPatchParticipant(b.token, id, { revision: 1, results: { golf: 9 } }, c),
        409,
        "STALE",
      );
      const results = await findResultsForParticipant(c, id);
      expect(results.golf?.value).toBe(2);
      // Retry of only the dirty field against latest revision succeeds.
      await supervisorPatchParticipant(b.token, id, { revision: 2, results: { throwing: 4 } }, c);
      const after = await findResultsForParticipant(c, id);
      expect(after.golf?.value).toBe(2);
      expect(after.throwing?.value).toBe(4);
    } finally {
      c.close();
    }
  });

  it("does not reattribute unchanged disciplines", async () => {
    const c = await freshClient();
    try {
      const { a, b } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await supervisorCreateParticipant(a.token, { id, name: "Mia", age_group: "up_to_14" }, c);
      await supervisorPatchParticipant(a.token, id, { revision: 1, results: { golf: 4 } }, c);
      // B writes same value + a new one: golf attribution must stay with A.
      await supervisorPatchParticipant(
        b.token, id, { revision: 2, results: { golf: 4, throwing: 1 } }, c,
      );
      const results = await findResultsForParticipant(c, id);
      expect(results.golf?.supervisorName).toBe("Anna Aufsicht");
      expect(results.throwing?.supervisorName).toBe("Ben Aufsicht");
    } finally {
      c.close();
    }
  });
});

describe("collection gate + revoked tokens", () => {
  it("rejects writes while closed", async () => {
    const c = await freshClient();
    try {
      const { a } = await setupTwoSupervisors(c);
      await adminSetCollection(false, c);
      const id = randomUUID();
      await expectCode(
        supervisorCreateParticipant(a.token, { id, name: "Zed", age_group: "up_to_14" }, c),
        409,
        "CLOSED",
      );
      // Reopen allowed while closed is tested separately; reads still work.
      const s = await supervisorGetState(a.token, c);
      expect(s.collectionOpen).toBe(false);
    } finally {
      c.close();
    }
  });

  it("rejects revoked tokens and missing auth", async () => {
    const c = await freshClient();
    try {
      const { a } = await setupTwoSupervisors(c);
      await adminDeleteSupervisor(a.id, c);
      await expectCode(supervisorGetState(a.token, c), 401, "UNAUTHORIZED");
      await expectCode(supervisorGetState(null, c), 401, "UNAUTHORIZED");
      const id = randomUUID();
      await expectCode(
        supervisorCreateParticipant(a.token, { id, name: "Zed", age_group: "up_to_14" }, c),
        401,
        "UNAUTHORIZED",
      );
      // Invite for deleted supervisor is gone.
      await expectCode(adminGetInvite(a.id, c), 404, "NOT_FOUND");
    } finally {
      c.close();
    }
  });
});

describe("finalize + reopen", () => {
  it("rejects incomplete finalize, locks after finalize, reopens editable", async () => {
    const c = await freshClient();
    try {
      const { a } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await supervisorCreateParticipant(a.token, { id, name: "Finn", age_group: "up_to_14" }, c);
      await supervisorPatchParticipant(a.token, id, { revision: 1, results: { golf: 3 } }, c);
      await expectCode(supervisorFinalize(a.token, id, 2, c), 409, "INCOMPLETE");
      await supervisorPatchParticipant(
        a.token, id,
        { revision: 2, results: { obstacle: 123, throwing: 2, peeling: 450 } }, c,
      );
      const fin = await supervisorFinalize(a.token, id, 3, c);
      expect(fin.status).toBe("finalized");
      await expectCode(
        supervisorPatchParticipant(a.token, id, { revision: 4, results: { golf: 5 } }, c),
        409,
        "FINALIZED",
      );
      // Finalized disappears from supervisor drafts.
      const hidden = await supervisorGetState(a.token, c);
      expect(hidden.participants.some((p) => p.id === id)).toBe(false);
      // Admin reopen (permitted even while closed) makes it editable again.
      await adminSetCollection(false, c);
      const reopened = await adminReopen(id, 4, c);
      expect(reopened.status).toBe("draft");
      await adminSetCollection(true, c);
      const edited = await supervisorPatchParticipant(
        a.token, id, { revision: 5, results: { golf: 5 } }, c,
      );
      expect(edited.revision).toBe(6);
    } finally {
      c.close();
    }
  });
});

describe("deletion semantics", () => {
  it("supervisor delete preserves attribution; participant delete cascades", async () => {
    const c = await freshClient();
    try {
      const { a } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await supervisorCreateParticipant(a.token, { id, name: "Lea", age_group: "over_14" }, c);
      await supervisorPatchParticipant(a.token, id, { revision: 1, results: { golf: 2 } }, c);
      await adminDeleteSupervisor(a.id, c);
      const admin = await adminGetState(c);
      expect(admin.supervisors.some((s) => s.id === a.id)).toBe(false);
      expect(admin.results[id]?.golf?.supervisorName).toBe("Anna Aufsicht");
      await adminDeleteParticipant(id, c);
      const after = await adminGetState(c);
      expect(after.participants.some((p) => p.id === id)).toBe(false);
      expect(after.results[id]).toBeUndefined();
    } finally {
      c.close();
    }
  });
});

describe("clearing results via explicit null", () => {
  it("removes only the named discipline, preserves 0, keeps other attribution", async () => {    const c = await freshClient();
    try {
      const { a, b } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await supervisorCreateParticipant(a.token, { id, name: "Kai", age_group: "up_to_14" }, c);
      await supervisorPatchParticipant(
        a.token, id,
        { revision: 1, results: { golf: 4, throwing: 0, obstacle: 123 } }, c,
      );
      // Other supervisor adds peeling.
      await supervisorPatchParticipant(b.token, id, { revision: 2, results: { peeling: 450 } }, c);
      // Clear golf only.
      const cleared = await supervisorPatchParticipant(
        a.token, id, { revision: 3, results: { golf: null } }, c,
      );
      expect(cleared.revision).toBe(4);
      const results = await findResultsForParticipant(c, id);
      expect(results.golf?.value).toBeUndefined();
      expect(results.throwing?.value).toBe(0);
      expect(results.throwing?.supervisorName).toBe("Anna Aufsicht");
      expect(results.obstacle?.value).toBe(123);
      expect(results.peeling?.supervisorName).toBe("Ben Aufsicht");
      // Numeric 0 stays a valid throwing result (not missing).
      expect(results.throwing).toBeDefined();
      // Cleared discipline excludes completion.
      await expectCode(supervisorFinalize(a.token, id, 4, c), 409, "INCOMPLETE");
      // Clearing an absent value is a no-op (no bump, no attribution invented).
      const noop = await supervisorPatchParticipant(
        a.token, id, { revision: 4, results: { golf: null } }, c,
      );
      expect(noop.revision).toBe(4);
      expect((await findResultsForParticipant(c, id)).golf?.value).toBeUndefined();
    } finally {
      c.close();
    }
  });

  it("clear respects closed / revoked / finalized / stale", async () => {
    const c = await freshClient();
    try {
      const { a } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await supervisorCreateParticipant(a.token, { id, name: "Udo", age_group: "over_14" }, c);
      await supervisorPatchParticipant(
        a.token, id,
        { revision: 1, results: { golf: 3, obstacle: 100, throwing: 1, peeling: 200 } }, c,
      );
      // Stale revision rejected.
      await expectCode(
        supervisorPatchParticipant(a.token, id, { revision: 1, results: { golf: null } }, c),
        409, "STALE",
      );
      // Closed collection rejected.
      await adminSetCollection(false, c);
      await expectCode(
        supervisorPatchParticipant(a.token, id, { revision: 2, results: { golf: null } }, c),
        409, "CLOSED",
      );
      await adminSetCollection(true, c);
      // Finalize then clear rejected as finalized.
      await supervisorFinalize(a.token, id, 2, c);
      await expectCode(
        supervisorPatchParticipant(a.token, id, { revision: 3, results: { golf: null } }, c),
        409, "FINALIZED",
      );
      // Revoked token rejected.
      await adminReopen(id, 3, c);
      await adminDeleteSupervisor(a.id, c);
      await expectCode(
        supervisorPatchParticipant(a.token, id, { revision: 4, results: { golf: null } }, c),
        401, "UNAUTHORIZED",
      );
    } finally {
      c.close();
    }
  });

  it("rejects unknown disciplines and non-null invalid values in clears", async () => {
    const c = await freshClient();
    try {
      const { a } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await supervisorCreateParticipant(a.token, { id, name: "Eva", age_group: "up_to_14" }, c);
      await expectCode(
        supervisorPatchParticipant(a.token, id, { revision: 1, results: { unknown: 3 } }, c),
        400, "INVALID",
      );
      await expectCode(
        supervisorPatchParticipant(a.token, id, { revision: 1, results: { golf: 0 } }, c),
        400, "INVALID",
      );
    } finally {
      c.close();
    }
  });
});

describe("run error counter persistence", () => {
  it("persists a count-only patch without a result and bumps revision once", async () => {
    const c = await freshClient();
    try {
      const { a } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await supervisorCreateParticipant(a.token, { id, name: "Runa", age_group: "up_to_14" }, c);
      const upd = await supervisorPatchParticipant(a.token, id, { revision: 1, run_errors: 2 }, c);
      expect(upd.revision).toBe(2);
      expect(upd.runErrors).toBe(2);
      const p = await findParticipant(c, id);
      expect(p?.runErrors).toBe(2);
      const res = await findResultsForParticipant(c, id);
      expect(res.obstacle?.value).toBeUndefined();
    } finally {
      c.close();
    }
  });

  it("combines time + count in one atomic patch with a single revision bump", async () => {
    const c = await freshClient();
    try {
      const { a } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await supervisorCreateParticipant(a.token, { id, name: "Taro", age_group: "up_to_14" }, c);
      const upd = await supervisorPatchParticipant(
        a.token, id, { revision: 1, run_errors: 3, results: { obstacle: 123 } }, c,
      );
      expect(upd.revision).toBe(2);
      expect(upd.runErrors).toBe(3);
      const res = await findResultsForParticipant(c, id);
      expect(res.obstacle?.value).toBe(123);
      expect(res.obstacle?.supervisorName).toBe("Anna Aufsicht");
    } finally {
      c.close();
    }
  });

  it("a count no-op leaves revision and attribution untouched", async () => {
    const c = await freshClient();
    try {
      const { a, b } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await supervisorCreateParticipant(a.token, { id, name: "Mia", age_group: "up_to_14" }, c);
      await supervisorPatchParticipant(
        a.token, id, { revision: 1, run_errors: 2, results: { obstacle: 123, golf: 3 } }, c,
      );
      // Same count, different writer: no revision bump, no reattribution.
      const noop = await supervisorPatchParticipant(b.token, id, { revision: 2, run_errors: 2 }, c);
      expect(noop.revision).toBe(2);
      expect(noop.runErrors).toBe(2);
      const res = await findResultsForParticipant(c, id);
      expect(res.obstacle?.supervisorName).toBe("Anna Aufsicht");
      expect(res.golf?.supervisorName).toBe("Anna Aufsicht");
    } finally {
      c.close();
    }
  });

  it("rejects invalid run_errors values", async () => {
    const c = await freshClient();
    try {
      const { a } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await supervisorCreateParticipant(a.token, { id, name: "Eva", age_group: "up_to_14" }, c);
      for (const bad of [-1, 1.5, "2", null, true, 1_000_001]) {
        await expectCode(
          supervisorPatchParticipant(a.token, id, { revision: 1, run_errors: bad as number }, c),
          400, "INVALID",
        );
      }
    } finally {
      c.close();
    }
  });

  it("rejects count patches when stale, closed, finalized or revoked", async () => {
    const c = await freshClient();
    try {
      const { a } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await supervisorCreateParticipant(a.token, { id, name: "Udo", age_group: "over_14" }, c);
      await expectCode(
        supervisorPatchParticipant(a.token, id, { revision: 99, run_errors: 1 }, c),
        409, "STALE",
      );
      await adminSetCollection(false, c);
      await expectCode(
        supervisorPatchParticipant(a.token, id, { revision: 1, run_errors: 1 }, c),
        409, "CLOSED",
      );
      await adminSetCollection(true, c);
      await supervisorPatchParticipant(
        a.token, id,
        { revision: 1, results: { golf: 3, obstacle: 100, throwing: 1, peeling: 200 }, run_errors: 1 }, c,
      );
      await supervisorFinalize(a.token, id, 2, c);
      await expectCode(
        supervisorPatchParticipant(a.token, id, { revision: 3, run_errors: 2 }, c),
        409, "FINALIZED",
      );
      await adminReopen(id, 3, c);
      await adminDeleteSupervisor(a.id, c);
      await expectCode(
        supervisorPatchParticipant(a.token, id, { revision: 4, run_errors: 2 }, c),
        401, "UNAUTHORIZED",
      );
    } finally {
      c.close();
    }
  });

  it("count changes by another supervisor reattribute only the run result", async () => {
    const c = await freshClient();
    try {
      const { a, b } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await supervisorCreateParticipant(a.token, { id, name: "Lina", age_group: "up_to_14" }, c);
      await supervisorPatchParticipant(
        a.token, id, { revision: 1, results: { obstacle: 123, golf: 3 } }, c,
      );
      const upd = await supervisorPatchParticipant(b.token, id, { revision: 2, run_errors: 2 }, c);
      expect(upd.revision).toBe(3);
      const res = await findResultsForParticipant(c, id);
      expect(res.obstacle?.supervisorName).toBe("Ben Aufsicht");
      expect(res.obstacle?.value).toBe(123);
      expect(res.golf?.supervisorName).toBe("Anna Aufsicht");
    } finally {
      c.close();
    }
  });

  it("admin participant delete removes run details", async () => {
    const c = await freshClient();
    try {
      const { a } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await supervisorCreateParticipant(a.token, { id, name: "Lea", age_group: "over_14" }, c);
      await supervisorPatchParticipant(a.token, id, { revision: 1, run_errors: 4 }, c);
      await adminDeleteParticipant(id, c);
      const rows = await c.execute({
        sql: "SELECT * FROM ko_run_details WHERE participant_id = ?",
        args: [id],
      });
      expect(rows.rows.length).toBe(0);
      const state = await adminGetState(c);
      expect(state.participants.some((p) => p.id === id)).toBe(false);
    } finally {
      c.close();
    }
  });

  it("clearing the run time preserves errors and keeps completion incomplete", async () => {
    const c = await freshClient();
    try {
      const { a } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await supervisorCreateParticipant(a.token, { id, name: "Kai", age_group: "up_to_14" }, c);
      await supervisorPatchParticipant(
        a.token, id, { revision: 1, results: { obstacle: 123 }, run_errors: 2 }, c,
      );
      const cleared = await supervisorPatchParticipant(
        a.token, id, { revision: 2, results: { obstacle: null } }, c,
      );
      expect(cleared.runErrors).toBe(2);
      const res = await findResultsForParticipant(c, id);
      expect(res.obstacle?.value).toBeUndefined();
      await expectCode(supervisorFinalize(a.token, id, 3, c), 409, "INCOMPLETE");
      // Counter may be reset to 0 explicitly via the editor.
      const reset = await supervisorPatchParticipant(a.token, id, { revision: 3, run_errors: 0 }, c);
      expect(reset.runErrors).toBe(0);
    } finally {
      c.close();
    }
  });
});

describe("malformed input + origin rules", () => {
  it("rejects invalid names, ages, values", async () => {
    const c = await freshClient();
    try {
      const { a } = await setupTwoSupervisors(c);
      const id = randomUUID();
      await expectCode(
        supervisorCreateParticipant(a.token, { id, name: "  ", age_group: "up_to_14" }, c),
        400, "INVALID",
      );
      await expectCode(
        supervisorCreateParticipant(a.token, { id, name: "Ok", age_group: "u9" }, c),
        400, "INVALID",
      );
      await supervisorCreateParticipant(a.token, { id, name: "Ok", age_group: "up_to_14" }, c);
      await expectCode(
        supervisorPatchParticipant(a.token, id, { revision: 1, results: { golf: 0 } }, c),
        400, "INVALID",
      );
      await expectCode(
        supervisorPatchParticipant(a.token, id, { revision: 1, results: { throwing: -1 } }, c),
        400, "INVALID",
      );
      await expectCode(
        supervisorPatchParticipant(a.token, id, { revision: 1, results: { obstacle: 0 } }, c),
        400, "INVALID",
      );
      await expectCode(
        supervisorPatchParticipant(a.token, id, { results: { golf: 2 } }, c),
        400, "INVALID",
      );
      await expectCode(adminCreateSupervisor("   ", c), 400, "INVALID");
    } finally {
      c.close();
    }
  });

  it("origin + content-type helpers", () => {
    expect(isForeignOrigin(null, "https://x.de")).toBe(false);
    expect(isForeignOrigin("https://x.de", "https://x.de")).toBe(false);
    expect(isForeignOrigin("https://evil.de", "https://x.de")).toBe(true);
    expect(isForeignOrigin("garbage", "https://x.de")).toBe(true);
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
  });
});
