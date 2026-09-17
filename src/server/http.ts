// Small HTTP helpers for the API dispatcher (pure, unit-testable).

/** True when an Origin header is present and differs from the request origin. */
export function isForeignOrigin(
  originHeader: string | null,
  requestOrigin: string,
): boolean {
  if (!originHeader) return false;
  try {
    return new URL(originHeader).origin !== requestOrigin;
  } catch {
    return true;
  }
}

/** True when the request declares a JSON content type. */
export function isJsonContentType(header: string | null): boolean {
  return (header ?? "").toLowerCase().includes("application/json");
}
