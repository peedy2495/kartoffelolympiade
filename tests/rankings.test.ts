import { describe, expect, it } from "vitest";
import type { Participant, ResultValue } from "../src/lib/contracts.js";
import { compareSporting, rankAgeGroups } from "../src/lib/rankings.js";

function p(
  id: string,
  name: string,
  ageGroup: "up_to_14" | "over_14",
  status: "draft" | "finalized" = "finalized",
  runErrors?: number,
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
    runErrors,
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

  it("ranks obstacle on effective time so error-adjusted order can differ from raw", () => {
    // Raw order: b (10,0 s) beats a (12,3 s). With 2 errors for a and 0 for b:
    // a effective 6,3 s, b effective 10,0 s -> a wins the obstacle discipline.
    const ps = [
      p("a", "A", "up_to_14", "finalized", 2),
      p("b", "B", "up_to_14", "finalized", 0),
    ];
    const r = resultsOf([
      { id: "a", vals: { golf: 2, obstacle: 123, throwing: 3, peeling: 100 } },
      { id: "b", vals: { golf: 4, obstacle: 100, throwing: 9, peeling: 100 } },
    ]);
    const [g] = rankAgeGroups(ps, r);
    const byId = Object.fromEntries(
      (g?.entries ?? []).map((e) => [e.participantId, e]),
    );
    expect(byId["a"]?.values.obstacle).toBe(63);
    expect(byId["b"]?.values.obstacle).toBe(100);
    expect(byId["a"]?.disciplineRanks.obstacle).toBe(1);
    expect(byId["b"]?.disciplineRanks.obstacle).toBe(2);
  });

  it("keeps age groups isolated under error adjustment", () => {
    const ps = [
      p("a", "A", "up_to_14", "finalized", 2),
      p("b", "B", "over_14", "finalized", 2),
    ];
    const r = resultsOf([
      { id: "a", vals: { golf: 9, obstacle: 123, throwing: 0, peeling: 900 } },
      { id: "b", vals: { golf: 1, obstacle: 100, throwing: 9, peeling: 100 } },
    ]);
    const [young, old] = rankAgeGroups(ps, r);
    expect(young?.entries).toHaveLength(1);
    expect(old?.entries).toHaveLength(1);
    expect(young?.entries[0]?.values.obstacle).toBe(63);
    expect(old?.entries[0]?.values.obstacle).toBe(40);
  });

  it("applies error adjustment on overall rank-sum ties and winners", () => {
    // Equal raw obstacle times; with different error counts the effective
    // times diverge and the discipline/overall ranks are not shared.
    const ps = [
      p("a", "A", "up_to_14", "finalized", 2),
      p("b", "B", "up_to_14", "finalized", 0),
    ];
    const r = resultsOf([
      { id: "a", vals: { golf: 2, obstacle: 100, throwing: 3, peeling: 100 } },
      { id: "b", vals: { golf: 2, obstacle: 100, throwing: 3, peeling: 100 } },
    ]);
    const [g] = rankAgeGroups(ps, r);
    expect(byIdValues(g, "a").obstacle).toBe(40);
    expect(byIdValues(g, "b").obstacle).toBe(100);
    // a (4,0 s effective) keeps the better obstacle time and overall position.
    const byId = Object.fromEntries(
      (g?.entries ?? []).map((e) => [e.participantId, e]),
    );
    expect(byId["a"]?.disciplineRanks.obstacle).toBe(1);
    expect(byId["b"]?.disciplineRanks.obstacle).toBe(2);
    expect(g?.overallRanks["a"]).toBe(1);
    expect(g?.overallRanks["b"]).toBe(2);
    expect(g?.winners.map((w) => w.participantId)).toEqual(["a"]);
  });

  it("excludes a participant without raw obstacle value even with errors set", () => {
    const ps = [
      p("a", "A", "up_to_14", "finalized", 3),
      p("b", "B", "up_to_14", "finalized", 0),
    ];
    // a has errors but no obstacle raw time -> incomplete, excluded.
    const r = resultsOf([
      { id: "a", vals: { golf: 2, throwing: 3, peeling: 100 } as never },
      { id: "b", vals: { golf: 2, obstacle: 100, throwing: 3, peeling: 100 } },
    ]);
    const [g] = rankAgeGroups(ps, r);
    expect(g?.entries.map((e) => e.participantId)).toEqual(["b"]);
  });
});

function byIdValues(
  g: ReturnType<typeof rankAgeGroups>[number] | undefined,
  id: string,
): Record<string, number> {
  const e = g?.entries.find((x) => x.participantId === id);
  return e?.values ?? {};
}

describe("compareSporting", () => {
  it("ranks by rank sum ascending, so a lower sum beats more wins", () => {
    expect(
      compareSporting(
        { rankSum: 7, firsts: 1, seconds: 3, thirds: 0 },
        { rankSum: 8, firsts: 2, seconds: 0, thirds: 2 },
      ),
    ).toBeLessThan(0);
  });

  it("resolves equal rank sums by count of first places", () => {
    expect(
      compareSporting(
        { rankSum: 6, firsts: 3, seconds: 0, thirds: 1 },
        { rankSum: 6, firsts: 2, seconds: 2, thirds: 0 },
      ),
    ).toBeLessThan(0);
  });

  it("resolves equal sums and firsts by count of seconds (ranks 1,1,2,4 vs 1,1,3,3)", () => {
    expect(
      compareSporting(
        { rankSum: 8, firsts: 2, seconds: 1, thirds: 0 },
        { rankSum: 8, firsts: 2, seconds: 0, thirds: 2 },
      ),
    ).toBeLessThan(0);
  });

  it("falls back to thirds only after sum, firsts and seconds tie", () => {
    expect(
      compareSporting(
        { rankSum: 6, firsts: 2, seconds: 1, thirds: 1 },
        { rankSum: 6, firsts: 2, seconds: 1, thirds: 0 },
      ),
    ).toBeLessThan(0);
  });

  it("returns 0 only for a fully tied sporting tuple", () => {
    expect(
      compareSporting(
        { rankSum: 6, firsts: 2, seconds: 2, thirds: 0 },
        { rankSum: 6, firsts: 2, seconds: 2, thirds: 0 },
      ),
    ).toBe(0);
  });
});

describe("rankings tie-break", () => {
  it("resolves equal rank sums by more firsts and picks the unique winner", () => {
    // A and B tie on sum 6 (golf shared first, A wins obstacle+peeling,
    // B wins throwing); A wins 3-2 on firsts. C is clearly last.
    const ps = [
      p("a", "A", "up_to_14"),
      p("b", "B", "up_to_14"),
      p("c", "C", "up_to_14"),
    ];
    const r = resultsOf([
      { id: "a", vals: { golf: 2, obstacle: 400, throwing: 1, peeling: 400 } },
      { id: "b", vals: { golf: 2, obstacle: 500, throwing: 5, peeling: 500 } },
      { id: "c", vals: { golf: 5, obstacle: 600, throwing: 3, peeling: 600 } },
    ]);
    const [g] = rankAgeGroups(ps, r);
    expect(g?.winners.map((w) => w.participantId)).toEqual(["a"]);
    expect(g?.overallRanks["a"]).toBe(1);
    expect(g?.overallRanks["b"]).toBe(2);
    expect(g?.overallRanks["c"]).toBe(3);
    const byId = Object.fromEntries(
      (g?.entries ?? []).map((e) => [e.participantId, e]),
    );
    // Shared golf first counts for both A and B.
    expect(byId["a"]?.disciplineRanks.golf).toBe(1);
    expect(byId["b"]?.disciplineRanks.golf).toBe(1);
    expect(byId["a"]?.firsts).toBe(3);
    expect(byId["b"]?.firsts).toBe(2);
    expect(byId["a"]?.seconds).toBe(0);
    expect(byId["a"]?.thirds).toBe(1);
    expect(byId["a"]?.rankSum).toBe(6);
    expect(byId["b"]?.rankSum).toBe(6);
    // Display order follows the sporting tuple: A before B before C.
    expect(g?.entries.map((e) => e.participantId)).toEqual(["a", "b", "c"]);
  });

  it("shares overall place and winners only on a fully tied sporting tuple", () => {
    const ps = [
      p("a", "A", "up_to_14"),
      p("b", "B", "up_to_14"),
      p("c", "C", "up_to_14"),
    ];
    const r = resultsOf([
      { id: "a", vals: { golf: 2, obstacle: 100, throwing: 3, peeling: 100 } },
      { id: "b", vals: { golf: 2, obstacle: 100, throwing: 3, peeling: 100 } },
      { id: "c", vals: { golf: 5, obstacle: 120, throwing: 1, peeling: 120 } },
    ]);
    const [g] = rankAgeGroups(ps, r);
    expect(g?.winners.map((w) => w.participantId).sort()).toEqual(["a", "b"]);
    expect(g?.overallRanks["a"]).toBe(1);
    expect(g?.overallRanks["b"]).toBe(1);
    expect(g?.overallRanks["c"]).toBe(3);
  });

  it("ranks by rank sum before wins: fewer wins but lower sum wins", () => {
    // A wins only golf and is 2nd everywhere else (sum 7); B wins
    // obstacle+throwing but is 3rd in golf and peeling (sum 8). A wins
    // overall despite winning fewer disciplines.
    const ps = [
      p("a", "A", "up_to_14"),
      p("b", "B", "up_to_14"),
      p("c", "C", "up_to_14"),
    ];
    const r = resultsOf([
      { id: "a", vals: { golf: 2, obstacle: 500, throwing: 5, peeling: 400 } },
      { id: "b", vals: { golf: 9, obstacle: 400, throwing: 9, peeling: 700 } },
      { id: "c", vals: { golf: 5, obstacle: 800, throwing: 1, peeling: 300 } },
    ]);
    const [g] = rankAgeGroups(ps, r);
    expect(g?.winners.map((w) => w.participantId)).toEqual(["a"]);
    expect(g?.overallRanks["a"]).toBe(1);
    expect(g?.overallRanks["b"]).toBe(2);
    const byId = Object.fromEntries(
      (g?.entries ?? []).map((e) => [e.participantId, e]),
    );
    expect(byId["a"]?.firsts).toBe(1);
    expect(byId["b"]?.firsts).toBe(2);
    expect(byId["a"]?.rankSum).toBe(7);
    expect(byId["b"]?.rankSum).toBe(8);
  });

  it("keeps tie-break winners isolated per age group", () => {
    // up_to_14: A wins equal-sum tie by more firsts.
    // over_14: swapped pattern makes B win by more firsts instead.
    const ps = [
      p("a", "A", "up_to_14"),
      p("b", "B", "up_to_14"),
      p("c", "C", "up_to_14"),
      p("a2", "A", "over_14"),
      p("b2", "B", "over_14"),
      p("c2", "C", "over_14"),
    ];
    const r = resultsOf([
      { id: "a", vals: { golf: 2, obstacle: 400, throwing: 1, peeling: 400 } },
      { id: "b", vals: { golf: 2, obstacle: 500, throwing: 5, peeling: 500 } },
      { id: "c", vals: { golf: 5, obstacle: 600, throwing: 3, peeling: 600 } },
      { id: "a2", vals: { golf: 2, obstacle: 500, throwing: 5, peeling: 500 } },
      { id: "b2", vals: { golf: 2, obstacle: 400, throwing: 1, peeling: 400 } },
      { id: "c2", vals: { golf: 5, obstacle: 600, throwing: 3, peeling: 600 } },
    ]);
    const [young, old] = rankAgeGroups(ps, r);
    expect(young?.winners.map((w) => w.participantId)).toEqual(["a"]);
    expect(old?.winners.map((w) => w.participantId)).toEqual(["b2"]);
    expect(young?.overallRanks["a"]).toBe(1);
    expect(old?.overallRanks["a2"]).toBe(2);
  });
});
