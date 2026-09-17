// Service layer: owns authorization and state rules. Used by the API dispatcher
// and directly by integration tests.
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import {
  DISCIPLINES,
  MAX_INPUT_VALUE,
  type AdminState,
  type AgeGroup,
  type Discipline,
  type Participant,
  type SupervisorState,
  type SupervisorWithToken,
} from "../lib/contracts.js";
import { isAgeGroup, validateName, validateStoredValue } from "../lib/validation.js";
import { getReadyClient } from "./db.js";
import {
  findParticipant,
  findResultsForParticipant,
  findSupervisorById,
  findSupervisorByToken,
  getCollectionOpen,
  listActiveSupervisors,
  listParticipants,
  listResults,
  type Executor,
} from "./repository.js";

export class ServiceError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const err = (status: number, code: string, message: string) =>
  new ServiceError(status, code, message);

export function newSupervisorToken(): string {
  return randomBytes(32).toString("base64url");
}

type Tx = Executor & {
  commit?: () => Promise<void>;
  rollback?: () => Promise<void>;
  close?: () => Promise<void>;
};

/** Open a write transaction; callers must commit/rollback and always close in finally. */
export async function beginWrite(client: Client): Promise<Tx> {
  const maybe = client as unknown as {
    transaction?: (mode?: string) => Promise<Tx>;
  };
  if (typeof maybe.transaction === "function") {
    return await maybe.transaction("write");
  }
  await client.execute("BEGIN IMMEDIATE");
  let done = false;
  return {
    execute: (client as Executor).execute.bind(client),
    commit: async () => {
      done = true;
      await client.execute("COMMIT");
    },
    rollback: async () => {
      if (done) return;
      try {
        await client.execute("ROLLBACK");
      } catch {
        // already committed/rolled back
      }
    },
    close: async () => {},
  };
}

export async function endTx(tx: Tx, committed: boolean): Promise<void> {
  try {
    if (committed) {
      await tx.commit?.();
    } else {
      await tx.rollback?.();
    }
  } finally {
    try {
      await tx.close?.();
    } catch {
      // ignore close errors
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

async function requireSupervisor(
  db: Executor,
  token: string | null,
): Promise<SupervisorWithToken> {
  if (!token) throw err(401, "UNAUTHORIZED", "Supervisor-Token fehlt.");
  const sup = await findSupervisorByToken(db, token);
  if (!sup) throw err(401, "UNAUTHORIZED", "Ungültiger oder entzogener Zugang.");
  return sup;
}

// ---------- admin reads/writes (same-origin, intentionally unauthenticated) ----------

export async function adminGetState(client?: Client): Promise<AdminState> {
  const db = client ?? (await getReadyClient());
  const [collectionOpen, participants, results, supervisors] =
    await Promise.all([
      getCollectionOpen(db),
      listParticipants(db),
      listResults(db),
      listActiveSupervisors(db),
    ]);
  return { collectionOpen, participants, results, supervisors };
}

export async function adminSetCollection(
  open: unknown,
  client?: Client,
): Promise<{ collectionOpen: boolean }> {
  if (typeof open !== "boolean") throw err(400, "INVALID", "open muss boolean sein.");
  const db = client ?? (await getReadyClient());
  await db.execute({
    sql: "UPDATE ko_settings SET value = ? WHERE key = 'collection_open'",
    args: [open ? "1" : "0"],
  });
  return { collectionOpen: open };
}

export async function adminCreateSupervisor(
  name: unknown,
  client?: Client,
): Promise<{ id: string; name: string; token: string }> {
  const clean = validateName(name);
  if (!clean) throw err(400, "INVALID", "Name muss 1..100 Zeichen haben.");
  const db = client ?? (await getReadyClient());
  const id = randomUUID();
  const token = newSupervisorToken();
  const now = nowIso();
  await db.execute({
    sql: "INSERT INTO ko_supervisors (id, name, token, active, created_at) VALUES (?, ?, ?, 1, ?)",
    args: [id, clean, token, now],
  });
  return { id, name: clean, token };
}

export async function adminGetInvite(
  supervisorId: string,
  client?: Client,
): Promise<{ id: string; name: string; token: string }> {
  const db = client ?? (await getReadyClient());
  const sup = await findSupervisorById(db, supervisorId);
  if (!sup || !sup.active || !sup.token)
    throw err(404, "NOT_FOUND", "Aufsicht nicht gefunden.");
  return { id: sup.id, name: sup.name, token: sup.token };
}

export async function adminDeleteSupervisor(
  supervisorId: string,
  client?: Client,
): Promise<{ ok: true }> {
  const db = client ?? (await getReadyClient());
  const sup = await findSupervisorById(db, supervisorId);
  if (!sup || !sup.active) throw err(404, "NOT_FOUND", "Aufsicht nicht gefunden.");
  // Soft-deactivate, clear token so it becomes unusable; historical attribution stays.
  await db.execute({
    sql: "UPDATE ko_supervisors SET active = 0, token = NULL WHERE id = ?",
    args: [supervisorId],
  });
  return { ok: true };
}

export async function adminDeleteParticipant(
  participantId: string,
  client?: Client,
): Promise<{ ok: true }> {
  const db = client ?? (await getReadyClient());
  const p = await findParticipant(db, participantId);
  if (!p) throw err(404, "NOT_FOUND", "Teilnehmer nicht gefunden.");
  await db.execute({
    sql: "DELETE FROM ko_results WHERE participant_id = ?",
    args: [participantId],
  });
  await db.execute({
    sql: "DELETE FROM ko_participants WHERE id = ?",
    args: [participantId],
  });
  return { ok: true };
}

export async function adminReopen(
  participantId: string,
  revision: unknown,
  client?: Client,
): Promise<Participant> {
  if (typeof revision !== "number" || !Number.isInteger(revision))
    throw err(400, "INVALID", "revision muss eine ganze Zahl sein.");
  const db = client ?? (await getReadyClient());
  const p = await findParticipant(db, participantId);
  if (!p) throw err(404, "NOT_FOUND", "Teilnehmer nicht gefunden.");
  if (p.status !== "finalized")
    throw err(409, "NOT_FINALIZED", "Nur abgeschlossene Teilnehmer können geöffnet werden.");
  if (p.revision !== revision)
    throw err(409, "STALE", "Veraltete revision — bitte neu laden.");
  const now = nowIso();
  // Permitted while closed; editing stays blocked until collection reopens.
  const upd = await db.execute({
    sql: "UPDATE ko_participants SET status = 'draft', finalized_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = 'finalized'",
    args: [now, participantId, revision],
  });
  if ((upd.rowsAffected ?? 0) === 0)
    throw err(409, "STALE", "Veraltete revision — bitte neu laden.");
  const updated = await findParticipant(db, participantId);
  if (!updated) throw err(404, "NOT_FOUND", "Teilnehmer nicht gefunden.");
  return updated;
}

// ---------- supervisor flows ----------

export async function supervisorGetState(
  token: string | null,
  client?: Client,
): Promise<SupervisorState> {
  const db = client ?? (await getReadyClient());
  const sup = await requireSupervisor(db, token);
  const [collectionOpen, participants, results] = await Promise.all([
    getCollectionOpen(db),
    listParticipants(db),
    listResults(db),
  ]);
  // Shared drafts (and finalized for completion visibility? plan says drafts only).
  // Return drafts only; finalized disappear from supervisors until reopened.
  const drafts = participants.filter((p) => p.status === "draft");
  const draftResults: SupervisorState["results"] = {};
  for (const d of drafts) {
    const r = results[d.id];
    if (r) draftResults[d.id] = r;
  }
  return {
    identity: { id: sup.id, name: sup.name },
    collectionOpen,
    participants: drafts,
    results: draftResults,
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function supervisorCreateParticipant(
  token: string | null,
  body: { id?: unknown; name?: unknown; age_group?: unknown },
  client?: Client,
): Promise<Participant> {
  const db = client ?? (await getReadyClient());
  const sup = await requireSupervisor(db, token);
  void sup;
  const id = body.id;
  const clean = validateName(body.name);
  if (typeof id !== "string" || !UUID_RE.test(id))
    throw err(400, "INVALID", "id muss eine UUID sein.");
  if (!clean) throw err(400, "INVALID", "Name muss 1..100 Zeichen haben.");
  if (!isAgeGroup(body.age_group))
    throw err(400, "INVALID", "age_group ungültig.");
  const tx = await beginWrite(db as Client);
  let committed = false;
  try {
    const open = await getCollectionOpen(tx);
    if (!open) throw err(409, "CLOSED", "Erfassung ist geschlossen.");
    const active = await findSupervisorByToken(tx, token as string);
    if (!active) throw err(401, "UNAUTHORIZED", "Ungültiger oder entzogener Zugang.");
    const existing = await findParticipant(tx, id);
    if (existing) {
      // Same-UUID retry is idempotent.
      committed = true;
      await endTx(tx, true);
      return existing;
    }
    const now = nowIso();
    await tx.execute({
      sql: "INSERT INTO ko_participants (id, name, age_group, status, revision, created_at, updated_at, finalized_at) VALUES (?, ?, ?, 'draft', 1, ?, ?, NULL)",
      args: [id, clean, body.age_group as AgeGroup, now, now],
    });
    const created = await findParticipant(tx, id);
    if (!created) throw err(500, "INTERNAL", "Erstellen fehlgeschlagen.");
    committed = true;
    await endTx(tx, true);
    return created;
  } catch (e) {
    if (!committed) await endTx(tx, false);
    throw e;
  }
}

export interface PatchBody {
  revision?: unknown;
  name?: unknown;
  age_group?: unknown;
  results?: unknown;
}

function parsePatchResults(
  input: unknown,
): Partial<Record<Discipline, number>> | null {
  if (input === undefined) return null;
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw err(400, "INVALID", "results muss ein Objekt sein.");
  const out: Partial<Record<Discipline, number>> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!DISCIPLINES.includes(k as Discipline))
      throw err(400, "INVALID", `Unbekannte Disziplin: ${k}.`);
    if (v === null || v === undefined) continue;
    const d = k as Discipline;
    if (!validateStoredValue(d, v))
      throw err(400, "INVALID", `Ungültiger Wert für ${d}.`);
    out[d] = v as number;
  }
  return out;
}

export async function supervisorPatchParticipant(
  token: string | null,
  participantId: string,
  body: PatchBody,
  client?: Client,
): Promise<Participant> {
  const db = client ?? (await getReadyClient());
  if (
    typeof body.revision !== "number" ||
    !Number.isInteger(body.revision)
  )
    throw err(400, "INVALID", "revision muss eine ganze Zahl sein.");
  let cleanName: string | null = null;
  if (body.name !== undefined) {
    cleanName = validateName(body.name);
    if (!cleanName) throw err(400, "INVALID", "Name muss 1..100 Zeichen haben.");
  }
  let cleanAge: AgeGroup | null = null;
  if (body.age_group !== undefined) {
    if (!isAgeGroup(body.age_group))
      throw err(400, "INVALID", "age_group ungültig.");
    cleanAge = body.age_group;
  }
  const cleanResults = parsePatchResults(body.results);
  if (cleanResults !== null && Object.keys(cleanResults).length > 100)
    throw err(400, "INVALID", "Zu viele Ergebnisse.");
  // Bound check defense in depth (validateStoredValue already bounds).
  for (const v of Object.values(cleanResults ?? {})) {
    if (typeof v === "number" && (v < 0 || v > MAX_INPUT_VALUE))
      throw err(400, "INVALID", "Wert außerhalb des Bereichs.");
  }

  const tx = await beginWrite(db as Client);
  let committed = false;
  try {
    const sup = await requireSupervisor(tx, token);
    const open = await getCollectionOpen(tx);
    if (!open) throw err(409, "CLOSED", "Erfassung ist geschlossen.");
    const p = await findParticipant(tx, participantId);
    if (!p) throw err(404, "NOT_FOUND", "Teilnehmer nicht gefunden.");
    if (p.status !== "draft")
      throw err(409, "FINALIZED", "Teilnehmer ist bereits abgeschlossen.");
    if (p.revision !== body.revision)
      throw err(409, "STALE", "Veraltete revision — bitte neu laden.");

    const now = nowIso();
    const newName = cleanName ?? p.name;
    const newAge = cleanAge ?? p.ageGroup;
    const metaChanged = newName !== p.name || newAge !== p.ageGroup;
    const current =
      cleanResults !== null
        ? await findResultsForParticipant(tx, participantId)
        : {};
    const changedResults: Array<[Discipline, number]> =
      cleanResults !== null
        ? (
            Object.entries(cleanResults) as Array<[Discipline, number]>
          ).filter(([d, v]) => current[d]?.value !== v)
        : [];
    if (!metaChanged && changedResults.length === 0) {
      // No-op patch: touch nothing, return current record.
      committed = true;
      await endTx(tx, true);
      return p;
    }
    // Single atomic revision bump for the whole patch.
    const upd = await tx.execute({
      sql: "UPDATE ko_participants SET name = ?, age_group = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = 'draft'",
      args: [newName, newAge, now, participantId, body.revision],
    });
    if ((upd.rowsAffected ?? 0) === 0)
      throw err(409, "STALE", "Veraltete revision — bitte neu laden.");
    // Only actually changed result values update attribution.
    for (const [d, v] of changedResults) {
      await tx.execute({
        sql: "INSERT INTO ko_results (participant_id, discipline, value, supervisor_id, supervisor_name, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (participant_id, discipline) DO UPDATE SET value = excluded.value, supervisor_id = excluded.supervisor_id, supervisor_name = excluded.supervisor_name, updated_at = excluded.updated_at",
        args: [participantId, d, v, sup.id, sup.name, now],
      });
    }
    const updated = await findParticipant(tx, participantId);
    if (!updated) throw err(404, "NOT_FOUND", "Teilnehmer nicht gefunden.");
    committed = true;
    await endTx(tx, true);
    return updated;
  } catch (e) {
    if (!committed) await endTx(tx, false);
    throw e;
  }
}

export async function supervisorFinalize(
  token: string | null,
  participantId: string,
  revision: unknown,
  client?: Client,
): Promise<Participant> {
  const db = client ?? (await getReadyClient());
  if (typeof revision !== "number" || !Number.isInteger(revision))
    throw err(400, "INVALID", "revision muss eine ganze Zahl sein.");
  const tx = await beginWrite(db as Client);
  let committed = false;
  try {
    await requireSupervisor(tx, token);
    const open = await getCollectionOpen(tx);
    if (!open) throw err(409, "CLOSED", "Erfassung ist geschlossen.");
    const active = await findSupervisorByToken(tx, token as string);
    if (!active) throw err(401, "UNAUTHORIZED", "Ungültiger oder entzogener Zugang.");
    const p = await findParticipant(tx, participantId);
    if (!p) throw err(404, "NOT_FOUND", "Teilnehmer nicht gefunden.");
    if (p.status !== "draft")
      throw err(409, "FINALIZED", "Teilnehmer ist bereits abgeschlossen.");
    if (p.revision !== revision)
      throw err(409, "STALE", "Veraltete revision — bitte neu laden.");
    const current = await findResultsForParticipant(tx, participantId);
    const missing = DISCIPLINES.filter((d) => current[d]?.value === undefined);
    if (missing.length > 0)
      throw err(409, "INCOMPLETE", `Unvollständig: ${missing.join(", ")}.`);
    const now = nowIso();
    const upd = await tx.execute({
      sql: "UPDATE ko_participants SET status = 'finalized', finalized_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = 'draft'",
      args: [now, now, participantId, revision],
    });
    if ((upd.rowsAffected ?? 0) === 0)
      throw err(409, "STALE", "Veraltete revision — bitte neu laden.");
    const updated = await findParticipant(tx, participantId);
    if (!updated || updated.status !== "finalized")
      throw err(409, "STALE", "Veraltete revision — bitte neu laden.");
    committed = true;
    await endTx(tx, true);
    return updated;
  } catch (e) {
    if (!committed) await endTx(tx, false);
    throw e;
  }
}
