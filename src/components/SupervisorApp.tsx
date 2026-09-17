import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgeGroup,
  Discipline,
  Participant,
  SupervisorState,
} from "../lib/contracts.js";
import { AGE_GROUP_LABELS_DE, DISCIPLINE_LABELS_DE } from "../lib/contracts.js";
import {
  formatTenthsToGerman,
  parseTimeInputToTenths,
} from "../lib/validation.js";
import { supervisorApi } from "../lib/api.js";

type FieldKey = "name" | "age" | Discipline;
type SaveStatus = "idle" | "saving" | "saved" | "error";

interface EditorFields {
  name: string;
  age: AgeGroup | null;
  golf: string;
  obstacle: string;
  throwing: string;
  peeling: string;
}

const EMPTY: EditorFields = {
  name: "",
  age: null,
  golf: "",
  obstacle: "",
  throwing: "",
  peeling: "",
};

function parseCount(raw: string, min: number): { ok: boolean; value: number | null } {
  const t = raw.trim();
  if (t === "") return { ok: true, value: null };
  if (!/^\d+$/.test(t)) return { ok: false, value: null };
  const v = Number(t);
  if (!Number.isInteger(v) || v < min || v > 1_000_000)
    return { ok: false, value: null };
  return { ok: true, value: v };
}

function parseField(
  key: Discipline,
  raw: string,
): { ok: boolean; value: number | null } {
  if (key === "golf") return parseCount(raw, 1);
  if (key === "throwing") return parseCount(raw, 0);
  const r = parseTimeInputToTenths(raw);
  return { ok: r.ok, value: r.tenths };
}

function serverFields(
  p: Participant,
  results: SupervisorState["results"],
): EditorFields {
  const r = results[p.id] ?? {};
  return {
    name: p.name,
    age: p.ageGroup,
    golf: r.golf?.value !== undefined ? String(r.golf.value) : "",
    obstacle:
      r.obstacle?.value !== undefined
        ? formatTenthsToGerman(r.obstacle.value)
        : "",
    throwing: r.throwing?.value !== undefined ? String(r.throwing.value) : "",
    peeling:
      r.peeling?.value !== undefined
        ? formatTenthsToGerman(r.peeling.value)
        : "",
  };
}

function completionOf(fields: EditorFields): number {
  let n = 0;
  if (parseField("golf", fields.golf).value !== null) n++;
  if (parseField("obstacle", fields.obstacle).value !== null) n++;
  if (parseField("throwing", fields.throwing).value !== null) n++;
  if (parseField("peeling", fields.peeling).value !== null) n++;
  return n;
}

// Stopwatch measured from performance.now (display only; submit on pause).
function useStopwatch() {
  const [elapsed, setElapsed] = useState(0); // ms
  const [running, setRunning] = useState(false);
  const ref = useRef<{ base: number; stamp: number }>({ base: 0, stamp: 0 });
  const timer = useRef<number | null>(null);

  const stopTick = useCallback(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(() => {
    ref.current = { base: elapsed, stamp: performance.now() };
    setRunning(true);
    stopTick();
    timer.current = window.setInterval(() => {
      setElapsed(ref.current.base + (performance.now() - ref.current.stamp));
    }, 100);
  }, [elapsed, stopTick]);

  const pause = useCallback(() => {
    const total = ref.current.base + (performance.now() - ref.current.stamp);
    stopTick();
    setRunning(false);
    setElapsed(total);
    return total;
  }, [stopTick]);

  const reset = useCallback(() => {
    stopTick();
    setRunning(false);
    setElapsed(0);
  }, [stopTick]);

  useEffect(() => stopTick, [stopTick]);
  return { elapsed, running, start, pause, reset };
}

// 60s countdown for 7-m throwing; never mutates hits.
function useCountdown() {
  const [remaining, setRemaining] = useState(60_000);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const ref = useRef<{ base: number; stamp: number }>({ base: 60_000, stamp: 0 });
  const timer = useRef<number | null>(null);

  const stopTick = useCallback(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(() => {
    if (ref.current.base <= 0) ref.current = { base: 60_000, stamp: 0 };
    ref.current.stamp = performance.now();
    setRunning(true);
    setFinished(false);
    stopTick();
    timer.current = window.setInterval(() => {
      const left = Math.max(
        0,
        ref.current.base - (performance.now() - ref.current.stamp),
      );
      setRemaining(left);
      if (left <= 0) {
        stopTick();
        setRunning(false);
        setFinished(true);
        try {
          const Ctx =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          if (Ctx) {
            const ctx = new Ctx();
            const osc = ctx.createOscillator();
            osc.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.25);
            osc.onended = () => void ctx.close();
          }
        } catch {
          // audio optional
        }
      }
    }, 100);
  }, [stopTick]);

  const pause = useCallback(() => {
    ref.current.base = Math.max(
      0,
      ref.current.base - (performance.now() - ref.current.stamp),
    );
    setRemaining(ref.current.base);
    setRunning(false);
    stopTick();
  }, [stopTick]);

  const reset = useCallback(() => {
    stopTick();
    setRunning(false);
    setFinished(false);
    ref.current = { base: 60_000, stamp: 0 };
    setRemaining(60_000);
  }, [stopTick]);

  useEffect(() => stopTick, [stopTick]);
  return { remaining, running, finished, start, pause, reset };
}

export function SupervisorApp({ token }: { token: string }) {
  const [server, setServer] = useState<SupervisorState | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAge, setNewAge] = useState<AgeGroup | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creatingBusy, setCreatingBusy] = useState(false);

  const [fields, setFields] = useState<EditorFields>(EMPTY);
  const [dirty, setDirty] = useState<Set<FieldKey>>(new Set());
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);

  const baseRevision = useRef(0);
  const baseSnapshot = useRef<EditorFields>(EMPTY);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const timersRunningRef = useRef(false);

  const swObstacle = useStopwatch();
  const swPeeling = useStopwatch();
  const cdThrow = useCountdown();
  const anyTimerRunning = swObstacle.running || swPeeling.running || cdThrow.running;
  timersRunningRef.current = anyTimerRunning;

  const selected: Participant | null = useMemo(
    () => server?.participants.find((p) => p.id === selectedId) ?? null,
    [server, selectedId],
  );

  const load = useCallback(
    async (silent = false) => {
      try {
        const s = await supervisorApi.state(token);
        setServer((prev) => {
          // Merge: never overwrite dirty editor fields silently.
          const selId = selectedRef.current;
          const d = dirtyRef.current;
          if (selId && d.size > 0) {
            const prevRec = prev?.participants.find((p) => p.id === selId);
            const nextRec = s.participants.find((p) => p.id === selId);
            if (nextRec && prevRec && nextRec.revision !== baseRevision.current) {
              setConflict(true);
            }
          } else if (selId) {
            const nextRec = s.participants.find((p) => p.id === selId);
            if (nextRec) {
              baseRevision.current = nextRec.revision;
              const fresh = serverFields(nextRec, s.results);
              baseSnapshot.current = fresh;
              setFields(fresh);
              setDirty(new Set());
              setFieldErrors({});
            }
          }
          return s;
        });
        setAccessError(null);
        setStale(false);
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 401) {
          setAccessError(
            "Dieser Zugang ist ungültig oder wurde entzogen. Bitte bei der Spielleitung einen neuen Einladungslink anfordern.",
          );
        } else if (!silent || server === null) {
          setAccessError(null);
          setStale(true);
        } else {
          setStale(true);
        }
      }
    },
    [token, server],
  );

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (!document.hidden) load(true);
    }, 3000);
    const onFocus = () => load(true);
    const onVis = () => {
      if (!document.hidden) load(true);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current.size > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Stop timers when collection closes (preserve input).
  const collectionOpen = server?.collectionOpen ?? false;
  useEffect(() => {
    if (server && !server.collectionOpen) {
      swObstacle.reset();
      swPeeling.reset();
      cdThrow.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.collectionOpen]);

  function editField(key: FieldKey, value: string | AgeGroup | null) {
    if (!collectionOpen) return;
    setFields((f) => ({ ...f, [key]: value }) as EditorFields);
    setDirty((d) => {
      const n = new Set(d);
      // Compare against snapshot; clear flag when back to saved value.
      const snap = baseSnapshot.current[key];
      const same = snap === (value as string);
      if (same) n.delete(key);
      else n.add(key);
      return n;
    });
    setFieldErrors((fe) => ({ ...fe, [key]: undefined }));
    setSaveStatus("idle");
    setConflict(false);
  }

  const flush = useCallback(
    (onlyKeys?: Set<FieldKey>) => {
      const run = async () => {
        const selId = selectedRef.current;
        const keys = onlyKeys ?? dirtyRef.current;
        if (!selId || keys.size === 0) return;
        const f = fieldsRef.current;
        const errs: Partial<Record<FieldKey, string>> = {};
        const results: Partial<Record<Discipline, number>> = {};
        let name: string | undefined;
        let age: AgeGroup | undefined;
        if (keys.has("name")) {
          const t = f.name.trim().replace(/\s+/g, " ");
          if (t.length < 1 || t.length > 100) errs.name = "Name muss 1–100 Zeichen haben.";
          else if (t !== baseSnapshot.current.name) name = t;
        }
        if (keys.has("age")) {
          if (f.age === null) errs.age = "Bitte Altersgruppe wählen.";
          else if (f.age !== baseSnapshot.current.age) age = f.age;
        }
        for (const d of ["golf", "obstacle", "throwing", "peeling"] as Discipline[]) {
          if (!keys.has(d)) continue;
          const parsed = parseField(d, f[d]);
          if (!parsed.ok) {
            errs[d] =
              d === "golf"
                ? "Ganze Zahl ab 1."
                : d === "throwing"
                  ? "Ganze Zahl ab 0."
                  : "Sekunden mit höchstens einer Nachkommastelle, z. B. 12,3.";
          } else if (parsed.value !== null) {
            results[d] = parsed.value;
          }
        }
        if (Object.keys(errs).length > 0) {
          setFieldErrors((fe) => ({ ...fe, ...errs }));
          setSaveStatus("error");
          setSaveError("Bitte Eingaben prüfen.");
          return;
        }
        if (name === undefined && age === undefined && Object.keys(results).length === 0) {
          setDirty((d) => {
            const n = new Set(d);
            for (const k of keys) n.delete(k);
            return n;
          });
          return;
        }
        setSaveStatus("saving");
        setSaveError(null);
        try {
          const updated = await supervisorApi.patch(token, selId, {
            revision: baseRevision.current,
            ...(name !== undefined ? { name } : {}),
            ...(age !== undefined ? { age_group: age } : {}),
            ...(Object.keys(results).length > 0 ? { results } : {}),
          });
          baseRevision.current = updated.revision;
          // Refresh snapshot for saved keys only.
          setFields((cur) => {
            const snap = { ...baseSnapshot.current };
            if (name !== undefined) snap.name = updated.name;
            if (age !== undefined) snap.age = updated.ageGroup;
            for (const d of Object.keys(results) as Discipline[]) {
              snap[d] = cur[d];
            }
            baseSnapshot.current = snap;
            return cur;
          });
          setDirty((d) => {
            const n = new Set(d);
            for (const k of keys) n.delete(k);
            return n;
          });
          setConflict(false);
          setSaveStatus("saved");
          await load(true);
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === "STALE") {
            setConflict(true);
            setSaveStatus("error");
            setSaveError("Zwischenzeitlich geändert — bitte entscheiden: neu laden oder erneut senden.");
          } else if (code === "CLOSED") {
            setSaveStatus("error");
            setSaveError("Erfassung ist geschlossen. Eingaben bleiben erhalten.");
            await load(true);
          } else if (code === "FINALIZED") {
            setSaveStatus("error");
            setSaveError("Teilnehmer ist bereits abgeschlossen.");
            await load(true);
          } else {
            setSaveStatus("error");
            setSaveError(e instanceof Error ? e.message : "Speichern fehlgeschlagen. Eingaben bleiben erhalten.");
          }
        }
      };
      chain.current = chain.current.then(run, run);
      return chain.current;
    },
    [token, load],
  );

  // 500ms debounce autosave.
  useEffect(() => {
    if (dirty.size === 0 || !selectedId) return;
    const t = setTimeout(() => flush(), 500);
    return () => clearTimeout(t);
  }, [dirty, fields, selectedId, flush]);

  function confirmAbandonTimers(): boolean {
    if (!timersRunningRef.current) return true;
    return window.confirm("Eine Zeitmessung läuft noch. Wirklich wechseln und verwerfen?");
  }

  function selectParticipant(id: string | null) {
    if (id !== selectedId && !confirmAbandonTimers()) return;
    swObstacle.reset();
    swPeeling.reset();
    cdThrow.reset();
    setConflict(false);
    setSaveError(null);
    setFinalizeError(null);
    setSaveStatus("idle");
    setCreating(false);
    if (id === null) {
      setSelectedId(null);
      setFields(EMPTY);
      setDirty(new Set());
      return;
    }
    const rec = server?.participants.find((p) => p.id === id);
    if (!rec || !server) return;
    baseRevision.current = rec.revision;
    const fresh = serverFields(rec, server.results);
    baseSnapshot.current = fresh;
    setFields(fresh);
    setDirty(new Set());
    setFieldErrors({});
    setSelectedId(id);
  }

  async function startParticipant() {
    const name = newName.trim().replace(/\s+/g, " ");
    if (name.length < 1 || name.length > 100) {
      setCreateError("Name muss 1–100 Zeichen haben.");
      return;
    }
    if (!newAge) {
      setCreateError("Bitte Altersgruppe wählen.");
      return;
    }
    setCreatingBusy(true);
    setCreateError(null);
    try {
      const id = crypto.randomUUID();
      const created = await supervisorApi.create(token, {
        id,
        name,
        age_group: newAge,
      });
      setNewName("");
      setNewAge(null);
      setCreating(false);
      await load(true);
      baseRevision.current = created.revision;
      const fresh: EditorFields = { ...EMPTY, name: created.name, age: created.ageGroup };
      baseSnapshot.current = fresh;
      setFields(fresh);
      setDirty(new Set());
      setFieldErrors({});
      setSelectedId(created.id);
      setSaveStatus("idle");
    } catch (e) {
      const code = (e as { code?: string }).code;
      setCreateError(
        code === "CLOSED"
          ? "Erfassung ist geschlossen."
          : e instanceof Error
            ? e.message
            : "Anlegen fehlgeschlagen.",
      );
    } finally {
      setCreatingBusy(false);
    }
  }

  async function finalize() {
    if (!selected || finalizing) return;
    setFinalizeError(null);
    await flush();
    await chain.current;
    if (dirtyRef.current.size > 0) {
      setFinalizeError("Offene Eingaben konnten nicht gespeichert werden.");
      return;
    }
    if (completionOf(fieldsRef.current) < 4) {
      setFinalizeError("Alle vier Werte sind erforderlich.");
      return;
    }
    setFinalizing(true);
    try {
      await supervisorApi.finalize(token, selected.id, baseRevision.current);
      selectParticipant(null);
      await load(true);
    } catch (e) {
      setFinalizeError(e instanceof Error ? e.message : "Abschließen fehlgeschlagen.");
    } finally {
      setFinalizing(false);
    }
  }

  if (accessError) {
    return (
      <div className="ko-card mx-auto max-w-xl p-6" role="alert">
        <h1 className="text-xl font-bold">Kein Zugang</h1>
        <p className="mt-2">{accessError}</p>
        <a className="ko-btn mt-4 inline-block" href="/">Zur Startseite</a>
      </div>
    );
  }
  if (!server) {
    return (
      <div className="ko-card p-6"><p>Lädt …</p></div>
    );
  }

  const q = search.trim().toLowerCase();
  const list = server.participants.filter(
    (p) => !q || p.name.toLowerCase().includes(q),
  );
  const complete = completionOf(fields);
  const hasFieldErrors = Object.values(fieldErrors).some(Boolean);
  const canFinalize =
    selected !== null &&
    collectionOpen &&
    complete === 4 &&
    !hasFieldErrors &&
    saveStatus !== "error" &&
    saveStatus !== "saving" &&
    !anyTimerRunning &&
    !conflict &&
    !finalizing;

  return (
    <div className="flex flex-col gap-5">
      <div className="ko-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-xl font-bold">Aufsicht: {server.identity.name}</h1>
            <p className="ko-hint">
              Erfassung: {collectionOpen ? "geöffnet" : "geschlossen"}
              {stale && " · Anzeige möglicherweise veraltet"}
            </p>
          </div>
          <span className="ko-badge ml-auto" data-testid="save-status">
            {saveStatus === "saving"
              ? "Speichert …"
              : saveStatus === "error"
                ? "Fehler"
                : saveStatus === "saved" && dirty.size === 0
                  ? "Gespeichert"
                  : dirty.size > 0
                    ? "Ungespeichert"
                    : "Bereit"}
          </span>
        </div>
        {!collectionOpen && (
          <p className="mt-2 font-semibold" role="status">
            Die Erfassung ist pausiert. Eingaben bleiben erhalten, Speichern ist deaktiviert.
          </p>
        )}
      </div>

      {selected === null ? (
        <div className="ko-card p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold">Offene Teilnehmer ({list.length})</h2>
            <button
              type="button"
              className="ko-btn ko-btn-primary ml-auto"
              data-testid="new-participant"
              onClick={() => {
                setCreating((c) => !c);
                setCreateError(null);
              }}
              disabled={!collectionOpen}
            >
              Neu
            </button>
          </div>
          {creating && (
            <div className="ko-soft mt-3 p-4" data-testid="create-form">
              <label className="ko-label" htmlFor="ko-new-name">Name</label>
              <input
                id="ko-new-name"
                className="ko-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Vor- und Nachname"
                maxLength={100}
              />
              <fieldset className="mt-3">
                <legend className="ko-label">Altersgruppe</legend>
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Altersgruppe">
                  {(["up_to_14", "over_14"] as AgeGroup[]).map((g) => (
                    <div
                      key={g}
                      className="ko-radio-card"
                      role="radio"
                      aria-checked={newAge === g}
                      tabIndex={0}
                      data-testid={`age-option-${g}`}
                      onClick={() => setNewAge(g)}
                      onKeyDown={(e) => {
                        if (e.key === " " || e.key === "Enter") {
                          e.preventDefault();
                          setNewAge(g);
                        }
                      }}
                    >
                      <span aria-hidden="true" className="inline-flex h-6 w-6 items-center justify-center rounded-full border">
                        {newAge === g ? "✓" : ""}
                      </span>
                      {AGE_GROUP_LABELS_DE[g]}
                    </div>
                  ))}
                </div>
              </fieldset>
              {createError && <p className="mt-2 font-semibold" role="alert">{createError}</p>}
              <button
                type="button"
                className="ko-btn ko-btn-primary mt-3"
                data-testid="start-participant"
                onClick={startParticipant}
                disabled={creatingBusy || !newName.trim() || !newAge}
              >
                Teilnehmer starten
              </button>
            </div>
          )}
          <input
            className="ko-input mt-3"
            type="search"
            placeholder="Suchen …"
            aria-label="Teilnehmer suchen"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {list.length === 0 ? (
            <p className="ko-hint mt-3">Noch keine offenen Teilnehmer. Über „Neu“ den ersten anlegen.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {list.map((p) => {
                const r = server.results[p.id] ?? {};
                const done = (["golf", "obstacle", "throwing", "peeling"] as Discipline[]).filter(
                  (d) => r[d]?.value !== undefined,
                ).length;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="ko-soft w-full p-3 text-left"
                      data-testid={`open-participant-${p.id}`}
                      onClick={() => selectParticipant(p.id)}
                    >
                      <span className="font-semibold">{p.name}</span>{" "}
                      <span className="ko-hint">
                        {AGE_GROUP_LABELS_DE[p.ageGroup]} · {done}/4
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <EditorView
          participant={selected}
          fields={fields}
          snapshot={baseSnapshot.current}
          fieldErrors={fieldErrors}
          collectionOpen={collectionOpen}
          saveError={saveError}
          conflict={conflict}
          onEdit={editField}
          onBlur={() => flush()}
          onBack={() => selectParticipant(null)}
          onRetryDirty={() => flush(new Set(dirtyRef.current))}
          onDiscard={() => {
            const rec = server.participants.find((p) => p.id === selected.id);
            if (rec) {
              baseRevision.current = rec.revision;
              const fresh = serverFields(rec, server.results);
              baseSnapshot.current = fresh;
              setFields(fresh);
              setDirty(new Set());
              setFieldErrors({});
              setConflict(false);
              setSaveStatus("idle");
              setSaveError(null);
            }
          }}
          swObstacle={swObstacle}
          swPeeling={swPeeling}
          cdThrow={cdThrow}
          complete={complete}
          canFinalize={canFinalize}
          finalizeError={finalizeError}
          finalizing={finalizing}
          onFinalize={finalize}
        />
      )}
    </div>
  );
}

function EditorView(props: {
  participant: Participant;
  fields: EditorFields;
  snapshot: EditorFields;
  fieldErrors: Partial<Record<FieldKey, string>>;
  collectionOpen: boolean;
  saveError: string | null;
  conflict: boolean;
  onEdit: (k: FieldKey, v: string | AgeGroup | null) => void;
  onBlur: () => void;
  onBack: () => void;
  onRetryDirty: () => void;
  onDiscard: () => void;
  swObstacle: ReturnType<typeof useStopwatch>;
  swPeeling: ReturnType<typeof useStopwatch>;
  cdThrow: ReturnType<typeof useCountdown>;
  complete: number;
  canFinalize: boolean;
  finalizeError: string | null;
  finalizing: boolean;
  onFinalize: () => void;
}) {
  const {
    participant, fields, fieldErrors, collectionOpen, saveError, conflict,
  } = props;
  const disabled = !collectionOpen;

  function stopwatchBlock(
    key: "obstacle" | "peeling",
    sw: ReturnType<typeof useStopwatch>,
    testid: string,
  ) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2" data-testid={testid}>
        <span className="ko-badge" aria-live="polite">
          {(sw.elapsed / 1000).toFixed(1).replace(".", ",")} s
        </span>
        {!sw.running ? (
          <button type="button" className="ko-btn" disabled={disabled} onClick={sw.start}>
            Start
          </button>
        ) : (
          <button
            type="button"
            className="ko-btn"
            onClick={() => {
              const total = sw.pause();
              const tenths = Math.max(1, Math.round(total / 100));
              props.onEdit(key, formatTenthsToGerman(tenths));
            }}
          >
            Pause
          </button>
        )}
        <button
          type="button"
          className="ko-btn"
          onClick={() => {
            sw.reset();
            // Reset stops the clock and returns the field to the saved value (or blank).
            props.onEdit(key, props.snapshot[key]);
          }}
        >
          Zurücksetzen
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="ko-card p-4 sm:p-5">
        <button type="button" className="ko-btn" onClick={props.onBack}>
          ← Zur Liste
        </button>
        <div className="mt-3">
          <label className="ko-label" htmlFor="ko-p-name">Name</label>
          <input
            id="ko-p-name"
            className="ko-input"
            data-testid="field-name"
            value={fields.name}
            disabled={disabled}
            maxLength={100}
            onChange={(e) => props.onEdit("name", e.target.value)}
            onBlur={props.onBlur}
          />
          {fieldErrors.name && <p className="mt-1 font-semibold" role="alert">{fieldErrors.name}</p>}
        </div>
        <fieldset className="mt-3">
          <legend className="ko-label">Altersgruppe</legend>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Altersgruppe">
            {(["up_to_14", "over_14"] as AgeGroup[]).map((g) => (
              <div
                key={g}
                className="ko-radio-card"
                role="radio"
                aria-checked={fields.age === g}
                tabIndex={disabled ? -1 : 0}
                data-testid={`age-option-${g}`}
                onClick={() => !disabled && props.onEdit("age", g)}
                onKeyDown={(e) => {
                  if ((e.key === " " || e.key === "Enter") && !disabled) {
                    e.preventDefault();
                    props.onEdit("age", g);
                  }
                }}
              >
                <span aria-hidden="true" className="inline-flex h-6 w-6 items-center justify-center rounded-full border">
                  {fields.age === g ? "✓" : ""}
                </span>
                {AGE_GROUP_LABELS_DE[g]}
              </div>
            ))}
          </div>
          {fieldErrors.age && <p className="mt-1 font-semibold" role="alert">{fieldErrors.age}</p>}
        </fieldset>
        <p className="ko-hint mt-2">Teilnehmer {participant.name} · {props.complete}/4 Werte · Revision {participant.revision}</p>
      </div>

      {conflict && (
        <div className="ko-card p-4" role="alert" data-testid="conflict-banner">
          <p className="font-bold">Zwischenzeitlich geändert</p>
          <p className="ko-hint">Deine Eingaben bleiben erhalten. Wähle, wie es weitergeht:</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="ko-btn" onClick={props.onDiscard}>
              Neu laden (eigene Eingaben verwerfen)
            </button>
            <button type="button" className="ko-btn ko-btn-primary" onClick={props.onRetryDirty}>
              Eigene Werte erneut senden
            </button>
          </div>
        </div>
      )}
      {saveError && (
        <div className="ko-card p-4" role="alert">
          <p>{saveError}</p>
          <button type="button" className="ko-btn mt-2" onClick={props.onRetryDirty}>
            Erneut versuchen
          </button>
        </div>
      )}

      {/* Discipline cards in stated order */}
      <section className="ko-card p-4 sm:p-5" aria-label={DISCIPLINE_LABELS_DE.golf}>
        <h3 className="text-lg font-bold">1. {DISCIPLINE_LABELS_DE.golf}</h3>
        <p className="ko-hint">Schläge — ganze Zahl ab 1.</p>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            className="ko-stepper-btn"
            aria-label="Schläge verringern"
            disabled={disabled}
            onClick={() => {
              const p = parseCount(fields.golf, 1);
              props.onEdit("golf", String(Math.max(1, (p.value ?? 2) - 1)));
            }}
          >
            −
          </button>
          <input
            className="ko-input text-center"
            data-testid="field-golf"
            inputMode="numeric"
            aria-label="Schläge"
            value={fields.golf}
            disabled={disabled}
            placeholder="–"
            onChange={(e) => props.onEdit("golf", e.target.value)}
            onBlur={props.onBlur}
          />
          <button
            type="button"
            className="ko-stepper-btn"
            aria-label="Schläge erhöhen"
            disabled={disabled}
            onClick={() => {
              const p = parseCount(fields.golf, 1);
              props.onEdit("golf", String((p.value ?? 0) + 1));
            }}
          >
            +
          </button>
        </div>
        {fieldErrors.golf && <p className="mt-1 font-semibold" role="alert">{fieldErrors.golf}</p>}
      </section>

      <section className="ko-card p-4 sm:p-5" aria-label={DISCIPLINE_LABELS_DE.obstacle}>
        <h3 className="text-lg font-bold">2. {DISCIPLINE_LABELS_DE.obstacle}</h3>
        <p className="ko-hint">Sekunden, z. B. 12,3 — oder Stoppuhr nutzen.</p>
        <input
          className="ko-input mt-2"
          data-testid="field-obstacle"
          inputMode="decimal"
          aria-label="Zeit Hindernisparcours in Sekunden"
          value={fields.obstacle}
          disabled={disabled}
          placeholder="z. B. 12,3"
          onChange={(e) => props.onEdit("obstacle", e.target.value)}
          onBlur={props.onBlur}
        />
        {fieldErrors.obstacle && <p className="mt-1 font-semibold" role="alert">{fieldErrors.obstacle}</p>}
        {stopwatchBlock("obstacle", props.swObstacle, "stopwatch-obstacle")}
      </section>

      <section className="ko-card p-4 sm:p-5" aria-label={DISCIPLINE_LABELS_DE.throwing}>
        <h3 className="text-lg font-bold">3. {DISCIPLINE_LABELS_DE.throwing}</h3>
        <p className="ko-hint">Treffer — ganze Zahl ab 0. Der Countdown verändert die Treffer nie automatisch.</p>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            className="ko-stepper-btn"
            aria-label="Treffer verringern"
            disabled={disabled}
            onClick={() => {
              const p = parseCount(fields.throwing, 0);
              props.onEdit("throwing", String(Math.max(0, (p.value ?? 1) - 1)));
            }}
          >
            −
          </button>
          <input
            className="ko-input text-center"
            data-testid="field-throwing"
            inputMode="numeric"
            aria-label="Treffer"
            value={fields.throwing}
            disabled={disabled}
            placeholder="–"
            onChange={(e) => props.onEdit("throwing", e.target.value)}
            onBlur={props.onBlur}
          />
          <button
            type="button"
            className="ko-stepper-btn"
            aria-label="Treffer erhöhen"
            disabled={disabled}
            onClick={() => {
              const p = parseCount(fields.throwing, 0);
              props.onEdit("throwing", String((p.value ?? -1) + 1));
            }}
          >
            +
          </button>
        </div>
        {fieldErrors.throwing && <p className="mt-1 font-semibold" role="alert">{fieldErrors.throwing}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="countdown-throwing">
          <span className="ko-badge" aria-live="polite" data-testid="countdown-display">
            {props.cdThrow.finished
              ? "Zeit um!"
              : `${(props.cdThrow.remaining / 1000).toFixed(1).replace(".", ",")} s`}
          </span>
          {!props.cdThrow.running ? (
            <button type="button" className="ko-btn" disabled={disabled} onClick={props.cdThrow.start}>
              {props.cdThrow.finished || props.cdThrow.remaining < 60_000 ? "Erneut starten (60 s)" : "Countdown starten (60 s)"}
            </button>
          ) : (
            <button type="button" className="ko-btn" onClick={props.cdThrow.pause}>
              Pause
            </button>
          )}
          <button type="button" className="ko-btn" onClick={props.cdThrow.reset}>
            Zurücksetzen
          </button>
        </div>
      </section>

      <section className="ko-card p-4 sm:p-5" aria-label={DISCIPLINE_LABELS_DE.peeling}>
        <h3 className="text-lg font-bold">4. {DISCIPLINE_LABELS_DE.peeling}</h3>
        <p className="ko-hint">Sekunden, z. B. 45,0 — oder Stoppuhr nutzen.</p>
        <input
          className="ko-input mt-2"
          data-testid="field-peeling"
          inputMode="decimal"
          aria-label="Zeit Kartoffelschälen in Sekunden"
          value={fields.peeling}
          disabled={disabled}
          placeholder="z. B. 45,0"
          onChange={(e) => props.onEdit("peeling", e.target.value)}
          onBlur={props.onBlur}
        />
        {fieldErrors.peeling && <p className="mt-1 font-semibold" role="alert">{fieldErrors.peeling}</p>}
        {stopwatchBlock("peeling", props.swPeeling, "stopwatch-peeling")}
      </section>

      <div className="ko-card p-4 sm:p-5">
        {props.finalizeError && <p className="mb-2 font-semibold" role="alert">{props.finalizeError}</p>}
        <button
          type="button"
          className="ko-btn ko-btn-primary w-full"
          data-testid="finalize"
          disabled={!props.canFinalize}
          onClick={props.onFinalize}
        >
          {props.finalizing ? "Wird abgeschlossen …" : "Speichern & abschließen"}
        </button>
        <p className="ko-hint mt-2">
          Alle vier Werte erforderlich. Nach dem Abschließen verschwindet der Teilnehmer hier —
          Korrekturen laufen über „Erneut öffnen“ im Admin-Bereich.
        </p>
      </div>
    </div>
  );
}
