import "server-only";
import { prisma } from "@/server/db/prisma";
import type { MutationStatus, ReviewStatus } from "@/generated/prisma/enums";
import { userSummarySelect } from "./user-repository";

export interface StatusCounts {
  total: number;
  pendingReview: number;
  approved: number;
  rejected: number;
  needsInformation: number;
  duplicate: number;
  withdrawn: number;
  surviving: number;
  killed: number;
  equivalent: number;
  invalid: number;
  unknown: number;
}

function emptyCounts(): StatusCounts {
  return {
    total: 0,
    pendingReview: 0,
    approved: 0,
    rejected: 0,
    needsInformation: 0,
    duplicate: 0,
    withdrawn: 0,
    surviving: 0,
    killed: 0,
    equivalent: 0,
    invalid: 0,
    unknown: 0,
  };
}

const REVIEW_KEY: Record<ReviewStatus, keyof StatusCounts> = {
  PENDING: "pendingReview",
  APPROVED: "approved",
  REJECTED: "rejected",
  NEEDS_INFORMATION: "needsInformation",
  DUPLICATE: "duplicate",
  WITHDRAWN: "withdrawn",
};

const MUTATION_KEY: Record<MutationStatus, keyof StatusCounts> = {
  SURVIVED: "surviving",
  KILLED: "killed",
  EQUIVALENT: "equivalent",
  INVALID: "invalid",
  UNKNOWN: "unknown",
};

export function foldStatusCounts(
  rows: ReadonlyArray<{ reviewStatus: ReviewStatus; mutationStatus: MutationStatus }>,
): StatusCounts {
  const counts = emptyCounts();
  for (const row of rows) {
    counts.total += 1;
    counts[REVIEW_KEY[row.reviewStatus]] += 1;
    counts[MUTATION_KEY[row.mutationStatus]] += 1;
  }
  return counts;
}

export const statsRepository = {
  async countsForProject(projectId: string): Promise<StatusCounts> {
    const rows = await prisma.mutant.findMany({
      where: { projectId },
      select: { reviewStatus: true, mutationStatus: true },
    });
    return foldStatusCounts(rows);
  },

  /**
   * Surviving mutants that are still the latest result for their mutation:
   * no newer commit killed it or showed it equivalent (see superseded.ts).
   */
  countLatestSurvivingForProject(projectId: string): Promise<number> {
    return prisma.mutant.count({
      where: { projectId, mutationStatus: "SURVIVED", superseded: false },
    });
  },

  async countsForUser(userId: string): Promise<StatusCounts> {
    const rows = await prisma.mutant.findMany({
      where: { createdById: userId },
      select: { reviewStatus: true, mutationStatus: true },
    });
    return foldStatusCounts(rows);
  },

  async globalCounts(): Promise<StatusCounts> {
    const rows = await prisma.mutant.findMany({
      select: { reviewStatus: true, mutationStatus: true },
    });
    return foldStatusCounts(rows);
  },

  async topContributorsForProject(projectId: string, take = 6) {
    const groups = await prisma.mutant.groupBy({
      by: ["createdById"],
      where: { projectId },
      _count: { _all: true },
      orderBy: { _count: { createdById: "desc" } },
      take,
    });
    const users = await prisma.user.findMany({
      where: { id: { in: groups.map((g) => g.createdById) } },
      select: userSummarySelect,
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return groups
      .map((g) => ({ user: byId.get(g.createdById), count: g._count._all }))
      .filter((g): g is { user: NonNullable<typeof g.user>; count: number } => Boolean(g.user));
  },

  async topFilesForProject(projectId: string, take = 8) {
    const groups = await prisma.mutant.groupBy({
      by: ["filePath"],
      where: { projectId },
      _count: { _all: true },
      orderBy: { _count: { filePath: "desc" } },
      take,
    });
    return groups.map((g) => ({ filePath: g.filePath, count: g._count._all }));
  },

  async platformTotals() {
    const [projects, mutants, validations, users] = await prisma.$transaction([
      prisma.project.count({ where: { isActive: true } }),
      prisma.mutant.count(),
      prisma.validation.count(),
      prisma.user.count(),
    ]);
    return { projects, mutants, validations, users };
  },
};
