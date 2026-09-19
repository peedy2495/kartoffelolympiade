// Shared typed model for Kartoffelolympiade.
// Comments in English; product UI strings stay in German (see components).

export const AGE_GROUPS = ["up_to_14", "over_14"] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

export const DISCIPLINES = [
  "golf",
  "obstacle",
  "throwing",
  "peeling",
] as const;
export type Discipline = (typeof DISCIPLINES)[number];

export const PARTICIPANT_STATUSES = ["draft", "finalized"] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];

export interface ResultValue {
  participantId: string;
  discipline: Discipline;
  /** Stored value: strokes (golf), hits (throwing), tenths of a second (obstacle/peeling). */
  value: number;
  supervisorId: string | null;
  supervisorName: string | null;
  updatedAt: string;
}

export interface Participant {
  id: string;
  name: string;
  ageGroup: AgeGroup;
  status: ParticipantStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  /** Saved Kartoffellauf error count; missing means 0 (old rows, fixtures). */
  runErrors?: number;
}

export interface Supervisor {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
}

/** Supervisor with token — only ever exposed via the dedicated invite endpoint. */
export interface SupervisorWithToken extends Supervisor {
  token: string;
}

export interface AdminState {
  collectionOpen: boolean;
  participants: Participant[];
  /** Keyed participantId -> discipline -> result. */
  results: Record<string, Partial<Record<Discipline, ResultValue>>>;
  supervisors: Supervisor[];
}

export interface SupervisorIdentity {
  id: string;
  name: string;
}

export interface SupervisorState {
  identity: SupervisorIdentity;
  collectionOpen: boolean;
  participants: Participant[];
  results: Record<string, Partial<Record<Discipline, ResultValue>>>;
}

export const DISCIPLINE_LABELS_DE: Record<Discipline, string> = {
  golf: "Kartoffel-Golf",
  obstacle: "Kartoffellauf",
  throwing: "7-m-Werfen",
  peeling: "Kartoffelschälen",
};

export const DISCIPLINE_UNITS_DE: Record<Discipline, string> = {
  golf: "Schläge",
  obstacle: "Sekunden",
  throwing: "Treffer",
  peeling: "Sekunden",
};

export const AGE_GROUP_LABELS_DE: Record<AgeGroup, string> = {
  up_to_14: "bis 14 Jahre",
  over_14: "über 14 Jahre",
};

/** Upper bound for all integer result inputs. */
export const MAX_INPUT_VALUE = 1_000_000;
/** Maximum raw HTTP JSON body accepted by the API dispatcher. */
export const MAX_BODY_BYTES = 16 * 1024;
