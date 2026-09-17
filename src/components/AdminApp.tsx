import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import {
  CheckIcon,
  EyeIcon,
  TrashIcon,
  ArrowPathIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import type {
  AdminState,
  AgeGroup,
  Discipline,
  Participant,
} from "../lib/contracts.js";
import { AGE_GROUP_LABELS_DE, DISCIPLINE_LABELS_DE, DISCIPLINES } from "../lib/contracts.js";
import { formatTenthsToGerman } from "../lib/validation.js";
import { disciplineLeaders, rankAgeGroups } from "../lib/rankings.js";
import { adminApi, inviteUrl } from "../lib/api.js";
import { QrModal } from "./QrModal.js";

function rawValue(d: Discipline, v: number | undefined): string {
  if (v === undefined) return "–";
  if (d === "obstacle" || d === "peeling") return `${formatTenthsToGerman(v)} s`;
  if (d === "golf") return `${v}`;
  return `${v}`;
}

export function AdminApp() {
  const [state, setState] = useState<AdminState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [ageFilter, setAgeFilter] = useState<"all" | AgeGroup>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "finalized">("all");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<{ name: string; token: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ kind: "sup" | "part"; id: string; name: string } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Synchronous pending guard: two clicks in the same tick must not send two
  // DELETEs (state updates are async and would let both through).
  const deleteBusyRef = useRef(false);

  const stateRef = useRef<AdminState | null>(null);
  const load = useCallback(async (silent = false) => {
    try {
      const s = await adminApi.state();
      stateRef.current = s;
      setState(s);
      setLoadError(null);
      setStale(false);
    } catch (e) {
      // Background polls never clear a mutation error; a failed poll with
      // existing data only marks the view as stale.
      if (stateRef.current === null)
        setLoadError(e instanceof Error ? e.message : "Laden fehlgeschlagen.");
      else setStale(true);
    }
  }, []);

  async function manualRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await load(false);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 3000);
    const onFocus = () => load(true);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rankings = useMemo(
    () => (state ? rankAgeGroups(state.participants, state.results) : []),
    [state],
  );

  async function toggleCollection() {
    if (!state || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await adminApi.setCollection(!state.collectionOpen);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Umschalten fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function createSupervisor() {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const created = await adminApi.createSupervisor(name);
      setNewName("");
      setQr({ name: created.name, token: created.token });
      await load();
    } catch (e) {
      // newName is kept so the entered name survives the failure.
      setActionError(e instanceof Error ? e.message : "Anlegen fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function openInvite(id: string, name: string) {
    setActionError(null);
    try {
      const inv = await adminApi.invite(id);
      setQr({ name: inv.name || name, token: inv.token });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Einladung fehlgeschlagen.");
    }
  }

  function openDelete(req: { kind: "sup" | "part"; id: string; name: string }) {
    setDeleteError(null);
    deleteBusyRef.current = false;
    setDeleteBusy(false);
    setConfirmDelete(req);
  }

  function closeDelete() {
    if (deleteBusyRef.current) return;
    setConfirmDelete(null);
    setDeleteError(null);
  }

  async function doDelete() {
    if (!confirmDelete || deleteBusyRef.current) return;
    deleteBusyRef.current = true;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      if (confirmDelete.kind === "sup") await adminApi.deleteSupervisor(confirmDelete.id);
      else await adminApi.deleteParticipant(confirmDelete.id);
      setConfirmDelete(null);
      await load();
    } catch (e) {
      // Failure stays inside the popup for retry; never hidden behind overlay.
      setDeleteError(e instanceof Error ? e.message : "Löschen fehlgeschlagen.");
    } finally {
      deleteBusyRef.current = false;
      setDeleteBusy(false);
    }
  }

  async function reopen(p: Participant) {
    setActionError(null);
    try {
      await adminApi.reopen(p.id, p.revision);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Öffnen fehlgeschlagen.");
    }
  }

  if (loadError && !state) {
    return (
      <div className="ko-card p-6">
        <h1 className="text-xl font-bold">Spielleitung</h1>
        <p className="mt-2">Fehler: {loadError}</p>
        <button type="button" className="ko-btn ko-btn-primary mt-4" onClick={() => load()}>
          Erneut versuchen
        </button>
      </div>
    );
  }
  if (!state) return <div className="ko-card p-6"><p>Lädt …</p></div>;

  const q = search.trim().toLowerCase();
  const filtered = state.participants.filter((p) => {
    if (ageFilter !== "all" && p.ageGroup !== ageFilter) return false;
    if (statusFilter !== "all" && p.status !== statusFilter) return false;
    if (q && !p.name.toLowerCase().includes(q)) return false;
    return true;
  });

  const drafts = state.participants.filter((p) => p.status === "draft").length;
  const finals = state.participants.filter((p) => p.status === "finalized").length;
  const young = state.participants.filter((p) => p.ageGroup === "up_to_14").length;
  const old = state.participants.filter((p) => p.ageGroup === "over_14").length;

  return (
    <div className="flex flex-col gap-6">
      <div className="ko-card flex flex-wrap items-center gap-3 p-4 sm:p-5">
        <div>
          <h1 className="text-xl font-bold">Spielleitung</h1>
          <p className="ko-hint">
            Erfassung: {state.collectionOpen ? "geöffnet" : "geschlossen"}
            {stale && " · Anzeige möglicherweise veraltet"}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <span className="ko-tip-anchor relative inline-flex">
            <button
              type="button"
              className="ko-btn"
              onClick={manualRefresh}
              disabled={refreshing}
              title="Daten neu laden"
              aria-label="Daten neu laden"
              aria-describedby="ko-refresh-tip"
            >
              <ArrowPathIcon
                className={`h-5 w-5${refreshing ? " animate-spin" : ""}`}
                aria-hidden="true"
              />
            </button>
            <span
              id="ko-refresh-tip"
              role="tooltip"
              className="ko-tip pointer-events-none absolute right-0 top-full z-10 mt-1 w-56 rounded bg-black px-2 py-1 text-xs text-white shadow"
            >
              Lädt die neuesten zentralen Daten neu. Ändert oder setzt nichts zurück.
            </span>
          </span>
          <button
            type="button"
            className={`ko-btn ${state.collectionOpen ? "" : "ko-btn-primary"}`}
            onClick={toggleCollection}
            disabled={busy}
          >
            {state.collectionOpen ? "Erfassung stoppen" : "Erfassung starten"}
          </button>
        </div>
      </div>
      {actionError && (
        <div className="ko-card p-4" role="alert">
          <p>Fehler: {actionError} <button type="button" className="ko-btn ml-2" onClick={() => setActionError(null)}>Schließen</button></p>
        </div>
      )}

      {/* 1. Teilnehmer FIRST */}
      <section className="ko-card p-4 sm:p-5" aria-label="Teilnehmer">
        <h2 className="text-lg font-bold">Teilnehmer ({filtered.length})</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <input
            className="ko-input"
            type="search"
            placeholder="Suchen …"
            aria-label="Teilnehmer suchen"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="ko-select" aria-label="Altersgruppe filtern" value={ageFilter} onChange={(e) => setAgeFilter(e.target.value as typeof ageFilter)}>
            <option value="all">Alle Altersgruppen</option>
            <option value="up_to_14">{AGE_GROUP_LABELS_DE.up_to_14}</option>
            <option value="over_14">{AGE_GROUP_LABELS_DE.over_14}</option>
          </select>
          <select className="ko-select" aria-label="Status filtern" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="all">Alle Status</option>
            <option value="draft">Entwurf</option>
            <option value="finalized">Abgeschlossen</option>
          </select>
        </div>
        {filtered.length === 0 ? (
          <p className="ko-hint mt-4">Noch keine Teilnehmer — Aufsichten legen Entwürfe an, sobald die Erfassung geöffnet ist.</p>
        ) : (
          <div className="ko-table-wrap mt-3">
            <table className="ko-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Gruppe</th>
                  {DISCIPLINES.map((d) => (
                    <th key={d}>{DISCIPLINE_LABELS_DE[d]}</th>
                  ))}
                  <th>Status</th>
                  <th>Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id}>
                    <td className="font-semibold">{p.name}</td>
                    <td>{AGE_GROUP_LABELS_DE[p.ageGroup]}</td>
                    {DISCIPLINES.map((d) => {
                      const r = state.results[p.id]?.[d];
                      return (
                        <td key={d}>
                          <div>{rawValue(d, r?.value)}</div>
                          {r?.supervisorName && (
                            <div className="ko-hint text-sm">⛹ {r.supervisorName}</div>
                          )}
                        </td>
                      );
                    })}
                    <td>
                      <span className="ko-badge">
                        {p.status === "finalized" ? "Abgeschlossen" : "Entwurf"}
                      </span>
                    </td>
                    <td>
                      <div className="flex gap-2">
                        {p.status === "finalized" && (
                          <button type="button" className="ko-btn" onClick={() => reopen(p)}>
                            Erneut öffnen
                          </button>
                        )}
                        <button
                          type="button"
                          className="ko-btn ko-btn-danger"
                          aria-label={`${p.name} löschen`}
                          onClick={() => openDelete({ kind: "part", id: p.id, name: p.name })}
                        >
                          <TrashIcon className="h-5 w-5" aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 2. Statistik SECOND */}
      <section className="ko-card p-4 sm:p-5" aria-label="Statistik">
        <h2 className="text-lg font-bold">Statistik</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            ["Gesamt", state.participants.length],
            ["Entwürfe", drafts],
            ["Abgeschlossen", finals],
            ["bis 14", young],
            ["über 14", old],
          ].map(([k, v]) => (
            <div key={k as string} className="ko-soft p-3 text-center">
              <dt className="ko-hint">{k}</dt>
              <dd className="text-2xl font-bold">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* 3. Aufsichten THIRD */}
      <section className="ko-card p-4 sm:p-5" aria-label="Aufsichten">
        <h2 className="text-lg font-bold">Aufsichten ({state.supervisors.length})</h2>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            className="ko-input flex-1"
            placeholder="Name der Aufsicht …"
            aria-label="Name der neuen Aufsicht"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createSupervisor()}
          />
          <button type="button" className="ko-btn ko-btn-primary" onClick={createSupervisor} disabled={busy || !newName.trim()}>
            Aufsicht anlegen
          </button>
        </div>
        {state.supervisors.length === 0 ? (
          <p className="ko-hint mt-3">Noch keine Aufsichten angelegt.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {state.supervisors.map((s) => (
              <li key={s.id} className="ko-soft flex items-center gap-2 p-3">
                <span className="font-semibold">{s.name}</span>
                <span className="ml-auto flex gap-2">
                  <button
                    type="button"
                    className="ko-btn"
                    aria-label={`Einladung für ${s.name} anzeigen`}
                    onClick={() => openInvite(s.id, s.name)}
                  >
                    <EyeIcon className="h-5 w-5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="ko-btn ko-btn-danger"
                    aria-label={`${s.name} entfernen`}
                    onClick={() => openDelete({ kind: "sup", id: s.id, name: s.name })}
                  >
                    <TrashIcon className="h-5 w-5" aria-hidden="true" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 4. Bestenlisten bottom */}
      <section className="ko-card p-4 sm:p-5" aria-label="Bestenlisten">
        <h2 className="text-lg font-bold">Bestenlisten</h2>
        <p className="ko-hint mt-1">
          Gesamtwertung: Summe der vier Disziplin-Platzierungen — je kleiner, desto besser.
          Bei Gleichstand teilen sich Teilnehmer den Platz.
        </p>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {rankings.map((g) => (
            <div key={g.ageGroup} className="ko-soft p-4">
              <h3 className="font-bold">{AGE_GROUP_LABELS_DE[g.ageGroup]}</h3>
              {g.entries.length === 0 ? (
                <p className="ko-hint mt-2">Noch keine abgeschlossenen Wertungen.</p>
              ) : (
                <>
                  <p className="mt-2 font-semibold">
                    Gesamt:{" "}
                    {g.winners.map((w) => `${w.name} (Platzsumme ${w.rankSum})`).join(" · ")}
                  </p>
                  {DISCIPLINES.map((d) => (
                    <p key={d} className="mt-1 text-base">
                      <span className="font-semibold">{DISCIPLINE_LABELS_DE[d]}: </span>
                      {disciplineLeaders(g, d)
                        .map((w) => `${w.name} (${rawValue(d, w.values[d])})`)
                        .join(" · ")}
                    </p>
                  ))}
                  <ol className="mt-2 flex flex-col gap-1">
                    {[...g.entries]
                      .sort((a, b) => (g.overallRanks[a.participantId] ?? 0) - (g.overallRanks[b.participantId] ?? 0))
                      .map((e) => (
                        <li key={e.participantId}>
                          Platz {g.overallRanks[e.participantId]}: {e.name} — Summe {e.rankSum}{" "}
                          <CheckIcon className="inline h-4 w-4" aria-hidden="true" />
                        </li>
                      ))}
                  </ol>
                </>
              )}
            </div>
          ))}
        </div>
      </section>

      {qr && (
        <QrModal
          open={true}
          name={qr.name}
          url={typeof window !== "undefined" ? inviteUrl(qr.token) : ""}
          onClose={() => setQr(null)}
        />
      )}
      {confirmDelete && (
        <Dialog.Root open={true} onOpenChange={(next) => !next && closeDelete()}>
          <Dialog.Portal>
            <Dialog.Backdrop className="ko-dialog-backdrop" />
            <Dialog.Popup
              className="ko-dialog-popup ko-card p-5"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="ko-delete-title"
              aria-describedby="ko-delete-desc"
            >
              <div className="flex items-start justify-between gap-3">
                <Dialog.Title id="ko-delete-title" className="text-lg font-bold">
                  {confirmDelete.kind === "sup" ? "Aufsicht entfernen" : "Teilnehmer löschen"}
                </Dialog.Title>
                <Dialog.Close
                  className="ko-btn px-3"
                  aria-label="Schließen"
                  onClick={closeDelete}
                >
                  <XMarkIcon className="h-5 w-5" aria-hidden="true" />
                </Dialog.Close>
              </div>
              <Dialog.Description id="ko-delete-desc" className="mt-1">
                „{confirmDelete.name}“ wirklich{" "}
                {confirmDelete.kind === "sup" ? "entfernen" : "löschen"}?
                {confirmDelete.kind === "sup"
                  ? " Ergebnisse bleiben mit Namen erhalten."
                  : " Alle Ergebnisse werden mit gelöscht."}
              </Dialog.Description>
              {deleteError && (
                <p className="mt-2 font-semibold" role="alert">
                  Löschen fehlgeschlagen: {deleteError}
                </p>
              )}
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  className="ko-btn flex-1"
                  data-testid="delete-cancel"
                  autoFocus
                  disabled={deleteBusy}
                  onClick={closeDelete}
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  className="ko-btn ko-btn-danger flex-1"
                  data-testid="delete-confirm"
                  disabled={deleteBusy}
                  onClick={doDelete}
                >
                  {deleteBusy ? "Wird gelöscht …" : "Bestätigen"}
                </button>
              </div>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </div>
  );
}
