// Exact allowlist for Astro's trusted-host / forwarded-header validation.
//
// Astro discards `host`, `x-forwarded-host` and `x-forwarded-proto` unless
// they match `security.allowedDomains` (see `security.allowedDomains` in the
// Astro config reference). Without an entry, a Vercel-style request is
// normalized to `https://localhost`, so the same-origin check in
// `src/pages/api/[...path].ts` rejects legitimate gamemaster POSTs with 403.
//
// This helper builds that list from exact hosts only:
// - default production host (https)
// - current Vercel deployment hosts from build env (https)
// - optional custom domain via APP_ORIGIN (explicit absolute http(s) URL)
// - local development (http, any port)
// Never emits wildcards or empty-hostname patterns (both would match too
// broadly); malformed values are skipped.

export interface AllowedDomain {
  hostname?: string;
  protocol?: string;
  port?: string;
}

const DEFAULT_PROD_HOST = "kartoffelolympiade.vercel.app";

/** Strict hostname: letters, digits, hyphens, dots — or exact `[::1]`. */
function isValidHostname(hostname: string): boolean {
  if (hostname === "[::1]") return true;
  if (hostname.length === 0 || hostname.length > 253) return false;
  if (
    hostname.includes("*") ||
    hostname.includes("/") ||
    hostname.includes("\\") ||
    hostname.includes("@") ||
    hostname.includes(":") ||
    hostname.includes("?") ||
    hostname.includes("#") ||
    hostname.includes(" ") ||
    hostname.includes("_")
  )
    return false;
  const labels = hostname.split(".");
  if (labels.some((l) => l.length === 0 || l.length > 63)) return false;
  if (labels.some((l) => l.startsWith("-") || l.endsWith("-"))) return false;
  return /^[a-z0-9.-]+$/i.test(hostname);
}

/** Extract an exact https host from a Vercel env value (bare host or URL). */
function parseVercelHost(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    const hostname = url.hostname.toLowerCase();
    if (!isValidHostname(hostname)) return null;
    // Never trust ports from Vercel env; deployment hosts serve default ports.
    return hostname;
  } catch {
    return null;
  }
}

/**
 * Parse APP_ORIGIN as an explicit absolute http(s) origin. Credentials,
 * query strings, hashes, paths and wildcards are rejected. An explicit port
 * is preserved.
 */
function parseAppOrigin(raw: string | undefined): AllowedDomain | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    const hostname = url.hostname.toLowerCase();
    if (!isValidHostname(hostname)) return null;
    const entry: AllowedDomain = {
      protocol: url.protocol.slice(0, -1),
      hostname,
    };
    if (url.port) entry.port = url.port;
    return entry;
  } catch {
    return null;
  }
}

export function buildAllowedDomains(
  env: NodeJS.ProcessEnv = process.env,
): AllowedDomain[] {
  const out: AllowedDomain[] = [];
  const seen = new Set<string>();
  const push = (entry: AllowedDomain): void => {
    // A missing hostname matches every host — never emit such a pattern.
    if (!entry.hostname || !isValidHostname(entry.hostname)) return;
    if (entry.protocol !== undefined && entry.protocol !== "http" && entry.protocol !== "https")
      return;
    if (
      entry.port !== undefined &&
      (entry.port.length === 0 || !/^\d+$/.test(entry.port))
    )
      return;
    const key = `${entry.protocol ?? ""}://${entry.hostname}${entry.port ? `:${entry.port}` : ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  push({ protocol: "https", hostname: DEFAULT_PROD_HOST });

  for (const name of ["VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL"] as const) {
    const host = parseVercelHost(env[name]);
    if (host) push({ protocol: "https", hostname: host });
  }

  const custom = parseAppOrigin(env["APP_ORIGIN"]);
  if (custom) push(custom);

  push({ protocol: "http", hostname: "localhost" });
  push({ protocol: "http", hostname: "127.0.0.1" });
  push({ protocol: "http", hostname: "[::1]" });

  return out;
}
