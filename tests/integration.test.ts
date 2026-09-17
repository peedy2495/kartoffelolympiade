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
import { findResultsForParticipant } from "../src/server/repository.ts";

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
