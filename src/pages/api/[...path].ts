import type { APIRoute } from "astro";
import { MAX_BODY_BYTES } from "../../lib/contracts.js";
import { getReadyClient } from "../../server/db.js";
import { isForeignOrigin, isJsonContentType } from "../../server/http.js";
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
} from "../../server/service.js";

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer (.+)$/.exec(h.trim());
  return m?.[1] ? m[1] : null;
}

/** Reject cross-origin mutations; same-origin admin stays intentionally unauthenticated. */
function foreignOrigin(req: Request, url: URL): boolean {
  return isForeignOrigin(req.headers.get("origin"), url.origin);
}

async function readBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES)
    throw new ServiceError(400, "TOO_LARGE", "Anfrage zu groß.");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError(400, "INVALID", "Ungültiges JSON.");
  }
}

function requireJson(req: Request): void {
  if (!isJsonContentType(req.headers.get("content-type")))
    throw new ServiceError(400, "INVALID", "Content-Type application/json erforderlich.");
}

export const ALL: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  // Route path below /api/
  const path = url.pathname.replace(/^\/api\/?/, "");
  const seg = path.split("/").filter(Boolean);

  try {
    // Removed namespace: no alias, no redirect, no database initialization.
    if (seg[0] === "admin") {
      return json({ error: "NOT_FOUND", message: "Unbekannte Route." }, 404);
    }
    const client = await getReadyClient();
    const isMutation = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    if (isMutation && foreignOrigin(request, url))
      return json({ error: "FORBIDDEN", message: "Fremder Origin abgelehnt." }, 403);

    // ---- gamemaster (same-origin, no credentials by explicit requirement) ----
    if (seg[0] === "gamemaster") {
      if (method === "GET" && seg[1] === "state" && seg.length === 2) {
        return json(await adminGetState(client));
      }
      if (method === "POST" && seg[1] === "collection" && seg.length === 2) {
        requireJson(request);
        const body = (await readBody(request)) as { open?: unknown };
        return json(await adminSetCollection(body.open, client));
      }
      if (method === "POST" && seg[1] === "supervisors" && seg.length === 2) {
        requireJson(request);
        const body = (await readBody(request)) as { name?: unknown };
        return json(await adminCreateSupervisor(body.name, client), 201);
      }
      if (
        method === "GET" &&
        seg[1] === "supervisors" &&
        seg[3] === "invite" &&
        seg.length === 4 &&
        seg[2]
      ) {
        return json(await adminGetInvite(seg[2], client));
      }
      if (method === "DELETE" && seg[1] === "supervisors" && seg.length === 3 && seg[2]) {
        return json(await adminDeleteSupervisor(seg[2], client));
      }
      if (method === "DELETE" && seg[1] === "participants" && seg.length === 3 && seg[2]) {
        return json(await adminDeleteParticipant(seg[2], client));
      }
      if (
        method === "POST" &&
        seg[1] === "participants" &&
        seg[3] === "reopen" &&
        seg.length === 4 &&
        seg[2]
      ) {
        requireJson(request);
        const body = (await readBody(request)) as { revision?: unknown };
        return json(await adminReopen(seg[2], body.revision, client));
      }
      return json({ error: "NOT_FOUND", message: "Unbekannte Spielleitungs-Route." }, 404);
    }

    // ---- supervisor (Bearer token required) ----
    const token = bearer(request);
    if (method === "GET" && seg.length === 1 && seg[0] === "state") {
      return json(await supervisorGetState(token, client));
    }
    if (method === "POST" && seg.length === 1 && seg[0] === "participants") {
      requireJson(request);
      const body = (await readBody(request)) as {
        id?: unknown;
        name?: unknown;
        age_group?: unknown;
      };
      return json(await supervisorCreateParticipant(token, body, client), 201);
    }
    if (
      (method === "PATCH" || method === "PUT") &&
      seg[0] === "participants" &&
      seg.length === 2 &&
      seg[1]
    ) {
      requireJson(request);
      const body = (await readBody(request)) as {
        revision?: unknown;
        name?: unknown;
        age_group?: unknown;
        results?: unknown;
      };
      return json(await supervisorPatchParticipant(token, seg[1], body, client));
    }
    if (
      method === "POST" &&
      seg[0] === "participants" &&
      seg[2] === "finalize" &&
      seg.length === 3 &&
      seg[1]
    ) {
      requireJson(request);
      const body = (await readBody(request)) as { revision?: unknown };
      return json(await supervisorFinalize(token, seg[1], body.revision, client));
    }
    return json({ error: "NOT_FOUND", message: "Unbekannte Route." }, 404);
  } catch (e) {
    if (e instanceof ServiceError)
      return json({ error: e.code, message: e.message }, e.status);
    console.error("API error", path, e instanceof Error ? e.message : e);
    return json({ error: "INTERNAL", message: "Interner Fehler." }, 500);
  }
};
