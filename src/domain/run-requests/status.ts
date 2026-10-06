import type { RunClaimStatus, RunRequestStatus } from "@/generated/prisma/enums";

/** How long an "I'm running this" claim holds without a report. */
export const CLAIM_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * What the board shows. Only OPEN / CLOSED / CANCELLED are stored; the rest
 * are derived from the claims and the pull request head at read time, so
 * nothing has to expire claims or watch the PR in the background.
 */
export type RunRequestDisplayStatus =
  "OPEN" | "IN_PROGRESS" | "REPORTED" | "OUTDATED" | "CLOSED" | "CANCELLED";

export const RUN_REQUEST_STATUS_LABEL: Record<RunRequestDisplayStatus, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  REPORTED: "Reported",
  OUTDATED: "Outdated",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

export interface ClaimState {
  status: RunClaimStatus;
  expiresAt: Date;
  commitSha: string | null;
}

export interface RunRequestState {
  status: RunRequestStatus;
  /** Commit the request targets. */
  headSha: string;
  /** Current head of the pull request. */
  prHeadSha: string;
  claims: ClaimState[];
}

/** An ACTIVE claim counts until it expires; reported or abandoned claims never do. */
export function isLiveClaim(claim: Pick<ClaimState, "status" | "expiresAt">, now: Date): boolean {
  return claim.status === "ACTIVE" && claim.expiresAt.getTime() > now.getTime();
}

/** SHAs match when one is a prefix of the other (reports may use short SHAs). */
export function sameCommit(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * Closed and cancelled win. A request whose PR moved past its target is
 * outdated, unless someone already reported a run at the new head. Then a
 * report at the target beats a live claim, which beats nothing.
 */
export function displayStatus(state: RunRequestState, now: Date): RunRequestDisplayStatus {
  if (state.status === "CLOSED") return "CLOSED";
  if (state.status === "CANCELLED") return "CANCELLED";
  const reports = state.claims.filter((c) => c.status === "REPORTED");
  if (!sameCommit(state.headSha, state.prHeadSha)) {
    return reports.some((c) => sameCommit(c.commitSha, state.prHeadSha)) ? "REPORTED" : "OUTDATED";
  }
  if (reports.length > 0) return "REPORTED";
  if (state.claims.some((c) => isLiveClaim(c, now))) return "IN_PROGRESS";
  return "OPEN";
}

/** Board order: requests that need a runner first, finished ones last. */
export const DISPLAY_STATUS_RANK: Record<RunRequestDisplayStatus, number> = {
  OPEN: 0,
  OUTDATED: 1,
  IN_PROGRESS: 2,
  REPORTED: 3,
  CLOSED: 4,
  CANCELLED: 5,
};

export interface RunCounts {
  generated: number;
  killed: number;
  survived: number;
}

/**
 * Killed + survived may be lower than generated (timeouts, build errors,
 * no coverage), never higher. Returns the field to flag, or null when valid.
 */
export function checkRunCounts(c: RunCounts): { field: keyof RunCounts; message: string } | null {
  if (c.killed > c.generated)
    return { field: "killed", message: "Cannot exceed the number of mutants generated" };
  if (c.survived > c.generated)
    return { field: "survived", message: "Cannot exceed the number of mutants generated" };
  if (c.killed + c.survived > c.generated)
    return { field: "survived", message: "Killed + survived cannot exceed mutants generated" };
  return null;
}

/** Mutation score of a run (killed / (killed + survived)), or null when nothing finished. */
export function mutationScore(c: Pick<RunCounts, "killed" | "survived">): number | null {
  const total = c.killed + c.survived;
  return total === 0 ? null : c.killed / total;
}
