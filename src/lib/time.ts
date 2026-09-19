// Time formatting and effective run time. Pure functions, no I/O.

/** Kartoffellauf deduction per error, in tenths of a second (3 s). */
export const ERROR_DEDUCTION_TENTHS = 30;

/** Floor an elapsed-milliseconds value to tenths of a second (display only). */
export function tenthsFromMillis(ms: number): number {
  return Math.floor(ms / 100);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * German compact duration from signed integer tenths of a second.
 * Hides unused leading units (hours/minutes), keeps inner zero fields to
 * avoid ambiguity; seconds and one tenth are always visible.
 * Examples: 0 -> "0,0 s"; 123 -> "12,3 s"; 600 -> "1 min 00,0 s";
 * 1234 -> "2 min 03,4 s"; 37234 -> "1 h 02 min 03,4 s".
 * Negative input renders a leading minus on the whole duration.
 */
export function formatDurationTenths(tenths: number): string {
  const sign = tenths < 0 ? "-" : "";
  const abs = Math.abs(tenths);
  const h = Math.floor(abs / 36000);
  const min = Math.floor((abs % 36000) / 600);
  const sec = Math.floor((abs % 600) / 10);
  const t = abs % 10;
  if (h > 0) return `${sign}${h} h ${pad2(min)} min ${pad2(sec)},${t} s`;
  if (min > 0) return `${sign}${min} min ${pad2(sec)},${t} s`;
  return `${sign}${sec},${t} s`;
}

/**
 * Effective run time: raw tenths minus 3 s per error (30 tenths each).
 * Literal subtraction: zero and negative results are allowed and displayed
 * signed; the stored raw time stays positive and is never overwritten.
 */
export function effectiveRunTenths(rawTenths: number, errors = 0): number {
  return rawTenths - errors * ERROR_DEDUCTION_TENTHS;
}