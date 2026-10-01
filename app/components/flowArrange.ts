/**
 * Display order for the Flow tab. This does not score contracts.
 * TAKE and WATCH lead. STOP stays with TAKE, because it is a TAKE the daily stop replaced.
 */

export type VerdictFilter = "all" | "TAKE" | "WATCH";
export type RightFilter = "all" | "call" | "put";
export type FlowSort = "grade" | "notional" | "volOi";

export interface FlowCardOrder {
  id: string;
  ticker: string;
  strike: number;
  putCall: "call" | "put";
  notionalPremium: number | null;
  volOiRatio: number | null;
  verdict?: { verdict: "TAKE" | "WATCH" | "SKIP" | "STOP"; grade: string } | null;
}

const GRADE_RANK: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };

export function arrangeFlowCards<T extends FlowCardOrder>(
  rows: readonly T[],
  options: { verdict: VerdictFilter; right: RightFilter; sort: FlowSort },
): T[] {
  const kept: T[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (options.right !== "all" && row.putCall !== options.right) continue;
    const name = row.verdict?.verdict;
    if (options.verdict === "TAKE" && name !== "TAKE" && name !== "STOP") continue;
    if (options.verdict === "WATCH" && name !== "WATCH") continue;
    kept.push(row);
  }
  kept.sort((a, b) => {
    const rank = verdictRank(a) - verdictRank(b);
    if (rank !== 0) return rank;
    const sorted = compareSort(a, b, options.sort);
    if (sorted !== 0) return sorted;
    if (a.ticker !== b.ticker) return a.ticker < b.ticker ? -1 : 1;
    if (a.strike !== b.strike) return a.strike - b.strike;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return kept;
}

function verdictRank(row: FlowCardOrder): number {
  const name = row.verdict?.verdict;
  if (name === "TAKE" || name === "STOP") return 0;
  if (name === "WATCH") return 1;
  if (name === "SKIP") return 2;
  return 3;
}

function compareSort(a: FlowCardOrder, b: FlowCardOrder, sort: FlowSort): number {
  if (sort === "notional") return (b.notionalPremium ?? -1) - (a.notionalPremium ?? -1);
  if (sort === "volOi") return (b.volOiRatio ?? -1) - (a.volOiRatio ?? -1);
  const grade = gradeRank(a) - gradeRank(b);
  if (grade !== 0) return grade;
  return (b.notionalPremium ?? -1) - (a.notionalPremium ?? -1);
}

function gradeRank(row: FlowCardOrder): number {
  const grade = row.verdict?.grade ?? "";
  return GRADE_RANK[grade] ?? 4;
}
