import { describe, expect, it } from "vitest";
import type { Participant, ResultValue } from "../src/lib/contracts.js";
import { rankAgeGroups } from "../src/lib/rankings.js";

function p(
  id: string,
  name: string,
  ageGroup: "up_to_14" | "over_14",
  status: "draft" | "finalized" = "finalized",
): Participant {
  return {
    id,
    name,
    ageGroup,
    status,
    revision: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    finalizedAt: status === "finalized" ? "2026-01-02T00:00:00Z" : null,
  };
}

function rv(
  pid: string,
  d: "golf" | "obstacle" | "throwing" | "peeling",
  value: number,
): ResultValue {
  return {
    participantId: pid,
    discipline: d,
    value,
    supervisorId: "s1",
    supervisorName: "Anna",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function resultsOf(
  entries: Array<{ id: string; vals: Record<string, number> }>,
): Record<string, Partial<Record<string, ResultValue>>> {
  const out: Record<string, Partial<Record<string, ResultValue>>> = {};
  for (const e of entries) {
    out[e.id] = Object.fromEntries(
      Object.entries(e.vals).map(([d, value]) => [
        d,
        rv(e.id, d as "golf", value),
      ]),
    );
  }
  // deno-lint-ignore: cast through unknown for test helper
  return out as Record<
    string,
    Partial<Record<"golf" | "obstacle" | "throwing" | "peeling", ResultValue>>
  >;
}

describe("rankings", () => {
  it("uses competition rank 1,1,3 on ties", () => {
    const ps = [
      p("a", "Anna T", "up_to_14"),
      p("b", "Ben T", "up_to_14"),
      p("c", "Cid T", "up_to_14"),
    ];
    const r = resultsOf([
      { id: "a", vals: { golf: 3, obstacle: 100, throwing: 5, peeling: 100 } },
      { id: "b", vals: { golf: 3, obstacle: 110, throwing: 4, peeling: 110 } },
      { id: "c", vals: { golf: 5, obstacle: 120, throwing: 3, peeling: 120 } },
    ]);
    const [g] = rankAgeGroups(ps, r);
    const byId = Object.fromEntries(
      (g?.entries ?? []).map((e) => [e.participantId, e]),
    );
    expect(byId["a"]?.disciplineRanks.golf).toBe(1);
    expect(byId["b"]?.disciplineRanks.golf).toBe(1);
    expect(byId["c"]?.disciplineRanks.golf).toBe(3);
  });

  it("ranks golf/time ascending and hits descending", () => {
    const ps = [p("a", "A", "up_to_14"), p("b", "B", "up_to_14")];
    const r = resultsOf([
      { id: "a", vals: { golf: 2, obstacle: 200, throwing: 1, peeling: 200 } },
      { id: "b", vals: { golf: 4, obstacle: 100, throwing: 9, peeling: 100 } },
    ]);
    const [g] = rankAgeGroups(ps, r);
    const byId = Object.fromEntries(
      (g?.entries ?? []).map((e) => [e.participantId, e]),
    );
    expect(byId["a"]?.disciplineRanks.golf).toBe(1);
    expect(byId["b"]?.disciplineRanks.obstacle).toBe(1);
    expect(byId["b"]?.disciplineRanks.throwing).toBe(1);
  });

  it("treats 0 hits as a valid value, not missing", () => {
    const ps = [p("a", "A", "up_to_14"), p("b", "B", "up_to_14")];
    const r = resultsOf([
      { id: "a", vals: { golf: 2, obstacle: 100, throwing: 0, peeling: 100 } },
      { id: "b", vals: { golf: 2, obstacle: 100, throwing: 3, peeling: 100 } },
    ]);
    const [g] = rankAgeGroups(ps, r);
    expect(g?.entries).toHaveLength(2);
    const byId = Object.fromEntries(
      (g?.entries ?? []).map((e) => [e.participantId, e]),
    );
    expect(byId["b"]?.disciplineRanks.throwing).toBe(1);
    expect(byId["a"]?.disciplineRanks.throwing).toBe(2);
  });

  it("keeps age groups isolated", () => {
    const ps = [p("a", "A", "up_to_14"), p("b", "B", "over_14")];
    const r = resultsOf([
      { id: "a", vals: { golf: 9, obstacle: 900, throwing: 0, peeling: 900 } },
      { id: "b", vals: { golf: 1, obstacle: 100, throwing: 9, peeling: 100 } },
    ]);
    const [young, old] = rankAgeGroups(ps, r);
    expect(young?.entries).toHaveLength(1);
    expect(old?.entries).toHaveLength(1);
    expect(young?.entries[0]?.disciplineRanks.golf).toBe(1);
  });

  it("excludes drafts, incomplete and reopened participants", () => {
    const ps = [
      p("a", "A", "up_to_14"),
      p("b", "B", "up_to_14", "draft"),
      p("c", "C", "up_to_14"),
    ];
    const r = resultsOf([
      { id: "a", vals: { golf: 2, obstacle: 100, throwing: 3, peeling: 100 } },
      { id: "b", vals: { golf: 1, obstacle: 50, throwing: 9, peeling: 50 } },
      { id: "c", vals: { golf: 2, obstacle: 100, throwing: 3 } as never },
    ]);
    const [g] = rankAgeGroups(ps, r);
    expect(g?.entries.map((e) => e.participantId)).toEqual(["a"]);
  });

  it("shares overall winning places on rank-sum ties", () => {
    const ps = [p("a", "A", "up_to_14"), p("b", "B", "up_to_14")];
    const r = resultsOf([
      { id: "a", vals: { golf: 2, obstacle: 100, throwing: 3, peeling: 100 } },
      { id: "b", vals: { golf: 2, obstacle: 100, throwing: 3, peeling: 100 } },
    ]);
    const [g] = rankAgeGroups(ps, r);
    expect(g?.winners).toHaveLength(2);
    expect(g?.overallRanks["a"]).toBe(1);
    expect(g?.overallRanks["b"]).toBe(1);
  });

  it("sorts equal display names by id for stable display only", () => {
    const ps = [p("b-id", "Gleich", "up_to_14"), p("a-id", "Gleich", "up_to_14")];
    const r = resultsOf([
      { id: "b-id", vals: { golf: 2, obstacle: 100, throwing: 3, peeling: 100 } },
      { id: "a-id", vals: { golf: 2, obstacle: 100, throwing: 3, peeling: 100 } },
    ]);
    const [g] = rankAgeGroups(ps, r);
    // Sporting tie kept (both overall rank 1), display ordered by id.
    expect(g?.overallRanks["a-id"]).toBe(1);
    expect(g?.overallRanks["b-id"]).toBe(1);
    expect(g?.entries[0]?.participantId).toBe("a-id");
  });
});
