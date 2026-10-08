import "server-only";
import { prisma } from "@/server/db/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { PullRequestState } from "@/generated/prisma/enums";
import { mutantListSelect } from "./mutant-repository";

export interface UpsertPullRequestData {
  projectId: string;
  number: number;
  title: string;
  authorLogin: string | null;
  state: PullRequestState;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  htmlUrl: string;
  changedRanges: Prisma.InputJsonValue;
  changedFiles: number;
  additions: number;
  deletions: number;
  /** False syncs the PR without listing it; never untracks a tracked PR. */
  tracked: boolean;
}

export const pullRequestSummarySelect = {
  id: true,
  number: true,
  title: true,
  authorLogin: true,
  state: true,
  baseRef: true,
  headRef: true,
  headSha: true,
  htmlUrl: true,
  changedFiles: true,
  additions: true,
  deletions: true,
  lastSyncedAt: true,
  updatedAt: true,
  _count: { select: { mutants: true } },
} satisfies Prisma.PullRequestSelect;

export type PullRequestSummary = Prisma.PullRequestGetPayload<{
  select: typeof pullRequestSummarySelect;
}>;

export const pullRequestRepository = {
  findByNumber(projectId: string, number: number) {
    return prisma.pullRequest.findUnique({
      where: { projectId_number: { projectId, number } },
      include: { project: true },
    });
  },

  findById(id: string) {
    return prisma.pullRequest.findUnique({ where: { id }, include: { project: true } });
  },

  listForProject(projectId: string, take = 50) {
    return prisma.pullRequest.findMany({
      where: { projectId, tracked: true },
      select: pullRequestSummarySelect,
      orderBy: [{ state: "asc" }, { updatedAt: "desc" }],
      take,
    });
  },

  upsert(data: UpsertPullRequestData) {
    const { projectId, number, tracked, ...rest } = data;
    return prisma.pullRequest.upsert({
      where: { projectId_number: { projectId, number } },
      create: { projectId, number, tracked, ...rest, lastSyncedAt: new Date() },
      update: { ...rest, ...(tracked ? { tracked } : {}), lastSyncedAt: new Date() },
      include: { project: true },
    });
  },

  /** Mutants recorded against any head revision of the PR, or explicitly scoped to it. */
  listMutants(pullRequestId: string) {
    return prisma.mutant.findMany({
      where: { OR: [{ pullRequestId }, { revision: { pullRequestId } }] },
      select: mutantListSelect,
      orderBy: [{ filePath: "asc" }, { startLine: "asc" }],
    });
  },

  /** Links a head revision to the PR (idempotent). */
  attachRevision(revisionId: string, pullRequestId: string) {
    return prisma.revision.update({ where: { id: revisionId }, data: { pullRequestId } });
  },

  recordCheckRun(id: string, checkRunId: string) {
    return prisma.pullRequest.update({
      where: { id },
      data: { checkRunId, checkRunAt: new Date() },
    });
  },
};
