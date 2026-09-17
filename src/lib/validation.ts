// Validation for shared model. Pure functions, no I/O.
import {
  AGE_GROUPS,
  DISCIPLINES,
  MAX_INPUT_VALUE,
  type AgeGroup,
  type Discipline,
} from "./contracts.js";

export type ValidationError = { field: string; message: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Trimmed display name, 1..100 chars. */
export function validateName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length < 1 || trimmed.length > 100) return null;
  return trimmed;
}

export function isAgeGroup(v: unknown): v is AgeGroup {
  return typeof v === "string" && (AGE_GROUPS as readonly string[]).includes(v);
}

export function isDiscipline(v: unknown): v is Discipline {
  return (
    typeof v === "string" && (DISCIPLINES as readonly string[]).includes(v)
  );
}

export function isUuid(v: unknown): boolean {
  return typeof v === "string" && UUID_RE.test(v);
}

/** Stored-value validation. null means missing (never coerce 0 hits to missing). */
export function validateStoredValue(
  discipline: Discipline,
  value: unknown,
): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "number" || !Number.isInteger(value)) return false;
  if (value < 0 || value > MAX_INPUT_VALUE) return false;
  switch (discipline) {
    case "golf":
      return value >= 1;
    case "throwing":
      return value >= 0;
    case "obstacle":
    case "peeling":
      // tenths of a second, must be positive
      return value >= 1;
  }
}

/**
 * Parse a German time input ("12,3" or "12.3", at most one decimal place)
 * into tenths of a second. Empty/blank returns null (missing).
 * Returns { ok, tenths } — tenths null means missing or invalid.
 */
export function parseTimeInputToTenths(
  raw: unknown,
): { ok: boolean; tenths: number | null } {
  if (raw === null || raw === undefined) return { ok: true, tenths: null };
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) return { ok: false, tenths: null };
    if (raw < 1 || raw > MAX_INPUT_VALUE)
      return { ok: false, tenths: null };
    return { ok: true, tenths: raw };
  }
  if (typeof raw !== "string") return { ok: false, tenths: null };
  const t = raw.trim().replace(/\s+/g, "");
  if (t === "") return { ok: true, tenths: null };
  const normalized = t.replace(",", ".");
  // Digits with at most one decimal place, e.g. "12", "12.3"
  if (!/^\d+(\.\d)?$/.test(normalized))
    return { ok: false, tenths: null };
  const seconds = Number(normalized);
  if (!Number.isFinite(seconds) || seconds <= 0)
    return { ok: false, tenths: null };
  const tenths = Math.round(seconds * 10);
  if (tenths < 1 || tenths > MAX_INPUT_VALUE)
    return { ok: false, tenths: null };
  return { ok: true, tenths };
}

/** Format stored tenths as German one-decimal seconds, e.g. 123 -> "12,3". */
export function formatTenthsToGerman(tenths: number): string {
  return (tenths / 10).toFixed(1).replace(".", ",");
}

/** Validate a partial discipline->value map from supervisor input. */
export function validateResultMap(
  input: unknown,
): { ok: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: "results", message: "invalid" }] };
  }
  for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
    if (!isDiscipline(key)) {
      errors.push({ field: `results.${key}`, message: "unknown discipline" });
      continue;
    }
    if (val === null) continue; // explicit null allowed? treat as invalid write below
    if (!validateStoredValue(key, val)) {
      errors.push({ field: `results.${key}`, message: "invalid value" });
    }
  }
  return { ok: errors.length === 0, errors };
}
