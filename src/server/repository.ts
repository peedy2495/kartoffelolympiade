// Centralized parameterized SQL. Works against Client or Transaction (both expose execute).
// Table prefix ko_ everywhere.
import type { Client } from "@libsql/client";
import type {
  AgeGroup,
  Discipline,
  Participant,
  ParticipantStatus,
  ResultValue,
  Supervisor,
  SupervisorWithToken,
} from "../lib/contracts.js";

export type Executor = Pick<Client, "execute">;

export function rowToSupervisor(row: Record<string, unknown>): Supervisor {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    active: Number(row["active"]) === 1,
    createdAt: String(row["created_at"]),
  };
}

export function rowToSupervisorWithToken(
  row: Record<string, unknown>,
): SupervisorWithToken {
  return { ...rowToSupervisor(row), token: String(row["token"] ?? "") };
}

export function rowToParticipant(row: Record<string, unknown>): Participant {
  const errors = row["errors"];
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    ageGroup: String(row["age_group"]) as AgeGroup,
    status: String(row["status"]) as ParticipantStatus,
    revision: Number(row["revision"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    finalizedAt:
      row["finalized_at"] === null || row["finalized_at"] === undefined
        ? null
        : String(row["finalized_at"]),
    runErrors:
      errors === null || errors === undefined ? 0 : Number(errors),
  };
}

export function rowToResult(row: Record<string, unknown>): ResultValue {
  return {
    participantId: String(row["participant_id"]),
    discipline: String(row["discipline"]) as Discipline,
    value: Number(row["value"]),
    supervisorId:
      row["supervisor_id"] === null || row["supervisor_id"] === undefined
        ? null
        : String(row["supervisor_id"]),
    supervisorName:
      row["supervisor_name"] === null || row["supervisor_name"] === undefined
        ? null
        : String(row["supervisor_name"]),
    updatedAt: String(row["updated_at"]),
  };
}

export async function getCollectionOpen(db: Executor): Promise<boolean> {
  const rs = await db.execute({
    sql: "SELECT value FROM ko_settings WHERE key = 'collection_open'",
    args: [],
  });
  const row = rs.rows[0] as Record<string, unknown> | undefined;
  return row !== undefined && String(row["value"]) === "1";
}

export async function listParticipants(db: Executor): Promise<Participant[]> {
  const rs = await db.execute({
    sql: "SELECT p.*, d.errors AS errors FROM ko_participants p LEFT JOIN ko_run_details d ON d.participant_id = p.id ORDER BY p.created_at ASC, p.id ASC",
    args: [],
  });
  return rs.rows.map((r) => rowToParticipant(r as Record<string, unknown>));
}

export async function listResults(
  db: Executor,
): Promise<Record<string, Partial<Record<Discipline, ResultValue>>>> {
  const rs = await db.execute({ sql: "SELECT * FROM ko_results", args: [] });
  const out: Record<string, Partial<Record<Discipline, ResultValue>>> = {};
  for (const r of rs.rows) {
    const rec = rowToResult(r as Record<string, unknown>);
    (out[rec.participantId] ??= {})[rec.discipline] = rec;
  }
  return out;
}

export async function listActiveSupervisors(
  db: Executor,
): Promise<Supervisor[]> {
  const rs = await db.execute({
    sql: "SELECT id, name, active, created_at FROM ko_supervisors WHERE active = 1 ORDER BY created_at ASC, id ASC",
    args: [],
  });
  return rs.rows.map((r) => rowToSupervisor(r as Record<string, unknown>));
}

export async function findSupervisorByToken(
  db: Executor,
  token: string,
): Promise<SupervisorWithToken | null> {
  const rs = await db.execute({
    sql: "SELECT * FROM ko_supervisors WHERE token = ? AND active = 1 LIMIT 1",
    args: [token],
  });
  const row = rs.rows[0] as Record<string, unknown> | undefined;
  if (!row || !row["token"]) return null;
  return rowToSupervisorWithToken(row);
}

export async function findSupervisorById(
  db: Executor,
  id: string,
): Promise<SupervisorWithToken | null> {
  const rs = await db.execute({
    sql: "SELECT * FROM ko_supervisors WHERE id = ? LIMIT 1",
    args: [id],
  });
  const row = rs.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToSupervisorWithToken(row) : null;
}

export async function findParticipant(
  db: Executor,
  id: string,
): Promise<Participant | null> {
  const rs = await db.execute({
    sql: "SELECT p.*, d.errors AS errors FROM ko_participants p LEFT JOIN ko_run_details d ON d.participant_id = p.id WHERE p.id = ? LIMIT 1",
    args: [id],
  });
  const row = rs.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToParticipant(row) : null;
}

export async function findResultsForParticipant(
  db: Executor,
  participantId: string,
): Promise<Partial<Record<Discipline, ResultValue>>> {
  const rs = await db.execute({
    sql: "SELECT * FROM ko_results WHERE participant_id = ?",
    args: [participantId],
  });
  const out: Partial<Record<Discipline, ResultValue>> = {};
  for (const r of rs.rows) {
    const rec = rowToResult(r as Record<string, unknown>);
    out[rec.discipline] = rec;
  }
  return out;
}
