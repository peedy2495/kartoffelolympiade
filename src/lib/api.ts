// Typed fetch helpers for gamemaster + supervisor REST endpoints.
import type {
  AdminState,
  AgeGroup,
  Discipline,
  Participant,
  SupervisorState,
} from "./contracts.js";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
  } & T;
  if (!res.ok) {
    const e = new Error(data.message ?? `Fehler ${res.status}`) as Error & {
      code?: string;
      status?: number;
    };
    e.code = data.error;
    e.status = res.status;
    throw e;
  }
  return data;
}

export const adminApi = {
  state: () => req<AdminState>("/api/gamemaster/state"),
  setCollection: (open: boolean) =>
    req<{ collectionOpen: boolean }>("/api/gamemaster/collection", {
      method: "POST",
      body: JSON.stringify({ open }),
    }),
  createSupervisor: (name: string) =>
    req<{ id: string; name: string; token: string }>("/api/gamemaster/supervisors", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  invite: (id: string) =>
    req<{ id: string; name: string; token: string }>(
      `/api/gamemaster/supervisors/${encodeURIComponent(id)}/invite`,
    ),
  deleteSupervisor: (id: string) =>
    req<{ ok: true }>(`/api/gamemaster/supervisors/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  deleteParticipant: (id: string) =>
    req<{ ok: true }>(`/api/gamemaster/participants/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  reopen: (id: string, revision: number) =>
    req<Participant>(`/api/gamemaster/participants/${encodeURIComponent(id)}/reopen`, {
      method: "POST",
      body: JSON.stringify({ revision }),
    }),
};

export function supervisorHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export const supervisorApi = {
  state: (token: string) =>
    req<SupervisorState>("/api/state", { headers: supervisorHeaders(token) }),
  create: (token: string, body: { id: string; name: string; age_group: AgeGroup }) =>
    req<Participant>("/api/participants", {
      method: "POST",
      headers: supervisorHeaders(token),
      body: JSON.stringify(body),
    }),
  patch: (
    token: string,
    id: string,
    body: {
      revision: number;
      name?: string;
      age_group?: AgeGroup;
      results?: Partial<Record<Discipline, number | null>>;
    },
  ) =>
    req<Participant>(`/api/participants/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: supervisorHeaders(token),
      body: JSON.stringify(body),
    }),
  finalize: (token: string, id: string, revision: number) =>
    req<Participant>(`/api/participants/${encodeURIComponent(id)}/finalize`, {
      method: "POST",
      headers: supervisorHeaders(token),
      body: JSON.stringify({ revision }),
    }),
};

/** Absolute same-origin invitation link for a supervisor token. */
export function inviteUrl(token: string): string {
  return `${window.location.origin}/aufsicht/${encodeURIComponent(token)}`;
}
