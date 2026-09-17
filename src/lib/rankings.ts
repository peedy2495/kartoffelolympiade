// Deterministic rankings: competition rank (1,1,3), per age group.
// Only finalized participants with all four results are ranked.
import {
  DISCIPLINES,
  type AgeGroup,
  type Discipline,
  type Participant,
  type ResultValue,
} from "./contracts.js";

export interface RankedEntry {
  participantId: string;
  name: string;
  ageGroup: AgeGroup;
  values: Record<Discipline, number>;
  /** Discipline -> competition rank (1-based). */
  disciplineRanks: Record<Discipline, number>;
  rankSum: number;
}

export interface AgeGroupRanking {
  ageGroup: AgeGroup;
  entries: RankedEntry[];
  /** Overall competition rank per participant id (rank-sum ascending). */
  overallRanks: Record<string, number>;
  /** All tied leaders (rank-sum == best). Empty when no entries. */
  winners: RankedEntry[];
}

function isLowerBetter(d: Discipline): boolean {
  // golf (strokes) asc, obstacle/peeling (time) asc, throwing (hits) desc
  return d !== "throwing";
}

function compareValues(a: number, b: number, lowerBetter: boolean): number {
  if (a === b) return 0;
  return lowerBetter ? (a < b ? -1 : 1) : a > b ? -1 : 1;
}

/** Competition ranks for a sorted list of [id, value]. Ties share rank; next rank skips. */
function competitionRanks(
  sorted: Array<{ id: string; value: number }>,
  lowerBetter: boolean,
): Record<string, number> {
  const ranks: Record<string, number> = {};
  let rank = 0;
  let prev: number | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    if (!cur) continue;
    if (prev === null || compareValues(cur.value, prev, lowerBetter) !== 0) {
      rank = i + 1;
      prev = cur.value;
    }
    ranks[cur.id] = rank;
  }
  return ranks;
}

/**
 * Build per-age-group rankings. `results` maps participantId -> discipline -> result.
 * Drafts, non-finalized, or incomplete participants are excluded.
 * Stable display: equal display names sort by id; sporting ties are never broken.
 */
export function rankAgeGroups(
  participants: Participant[],
  results: Record<string, Partial<Record<Discipline, ResultValue>>>,
): AgeGroupRanking[] {
  const groups: AgeGroup[] = ["up_to_14", "over_14"];
  return groups.map((ageGroup) => {
    const complete = participants
      .filter((p) => p.ageGroup === ageGroup && p.status === "finalized")
      .filter((p) => {
        const r = results[p.id];
        if (!r) return false;
        return DISCIPLINES.every((d) => r[d]?.value !== undefined);
      })
      .map((p) => ({
        participant: p,
        values: Object.fromEntries(
          DISCIPLINES.map((d) => [d, (results[p.id]?.[d] as ResultValue).value]),
        ) as Record<Discipline, number>,
      }));
    // Stable display order by name then id (display only).
    complete.sort((a, b) => {
      const n = a.participant.name.localeCompare(b.participant.name, "de");
      if (n !== 0) return n;
      return a.participant.id < b.participant.id ? -1 : 1;
    });

    const disciplineRanks: Record<Discipline, Record<string, number>> = {
      golf: {},
      obstacle: {},
      throwing: {},
      peeling: {},
    };
    for (const d of DISCIPLINES) {
      const sorted = complete
        .map((c) => ({ id: c.participant.id, value: c.values[d] }))
        .sort((a, b) => compareValues(a.value, b.value, isLowerBetter(d)));
      disciplineRanks[d] = competitionRanks(sorted, isLowerBetter(d));
    }

    const entries: RankedEntry[] = complete.map((c) => {
      const dr = Object.fromEntries(
        DISCIPLINES.map((d) => [d, disciplineRanks[d]?.[c.participant.id] ?? 0]),
      ) as Record<Discipline, number>;
      return {
        participantId: c.participant.id,
        name: c.participant.name,
        ageGroup,
        values: c.values,
        disciplineRanks: dr,
        rankSum: DISCIPLINES.reduce((s, d) => s + (dr[d] ?? 0), 0),
      };
    });

    // Overall: rank-sum ascending; ties share overall rank (competition ranking).
    const sortedOverall = [...entries].sort((a, b) => {
      if (a.rankSum !== b.rankSum) return a.rankSum - b.rankSum;
      const n = a.name.localeCompare(b.name, "de");
      if (n !== 0) return n;
      return a.participantId < b.participantId ? -1 : 1;
    });
    const overallRanks: Record<string, number> = {};
    let orank = 0;
    let prevSum: number | null = null;
    sortedOverall.forEach((e, i) => {
      if (prevSum === null || e.rankSum !== prevSum) {
        orank = i + 1;
        prevSum = e.rankSum;
      }
      overallRanks[e.participantId] = orank;
    });
    const best = sortedOverall.length > 0 ? sortedOverall[0]?.rankSum : null;
    const winners =
      best === null || best === undefined
        ? []
        : sortedOverall.filter((e) => e.rankSum === best);

    return { ageGroup, entries, overallRanks, winners };
  });
}

/** Leaders per age group and discipline (all tied best included). */
export function disciplineLeaders(
  ranking: AgeGroupRanking,
  discipline: Discipline,
): RankedEntry[] {
  if (ranking.entries.length === 0) return [];
  const bestRank = Math.min(
    ...ranking.entries.map((e) => e.disciplineRanks[discipline]),
  );
  return ranking.entries.filter(
    (e) => e.disciplineRanks[discipline] === bestRank,
  );
}
