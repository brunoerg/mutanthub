import "server-only";
import { prisma } from "@/server/db/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type {
  ActivityType,
  MutationOperator,
  MutationStatus,
  ObservedResult,
  ReviewStatus,
  StatusKind,
  DriftStatus,
} from "@/generated/prisma/enums";
import { userSummarySelect } from "./user-repository";
import { notificationRepository } from "./notification-repository";
import { refreshSuperseded } from "./superseded";

/** Fields shown in lists (mutant tables, review queue rows, dashboards). */
export const mutantListSelect = {
  id: true,
  title: true,
  filePath: true,
  startLine: true,
  endLine: true,
  mutationOperator: true,
  reviewStatus: true,
  mutationStatus: true,
  fingerprint: true,
  duplicateOfId: true,
  pullRequestId: true,
  driftStatus: true,
  driftLine: true,
  driftCommitSha: true,
  superseded: true,
  createdAt: true,
  updatedAt: true,
  project: {
    select: {
      id: true,
      githubOwner: true,
      githubRepository: true,
      displayName: true,
      language: true,
    },
  },
  revision: { select: { id: true, commitSha: true, branch: true } },
  createdBy: { select: userSummarySelect },
  validations: { select: { result: true } },
  _count: { select: { comments: true, validations: true } },
} satisfies Prisma.MutantSelect;

export type MutantListItem = Prisma.MutantGetPayload<{ select: typeof mutantListSelect }>;

const pullRequestSummarySelect = {
  number: true,
  title: true,
  state: true,
  headSha: true,
} satisfies Prisma.PullRequestSelect;

/** Everything the detail page and the review panel need. */
export const mutantDetailInclude = {
  project: true,
  // A mutant belongs to a PR when submitted against it, or when recorded at one of its heads.
  revision: { include: { pullRequest: { select: pullRequestSummarySelect } } },
  pullRequest: { select: pullRequestSummarySelect },
  createdBy: { select: userSummarySelect },
  duplicateOf: { select: { id: true, title: true, reviewStatus: true } },
  duplicates: { select: { id: true, title: true, createdAt: true } },
  submissions: {
    include: { submittedBy: { select: userSummarySelect } },
    orderBy: { createdAt: "asc" },
  },
  validations: {
    include: { user: { select: userSummarySelect } },
    orderBy: { createdAt: "asc" },
  },
  comments: {
    include: { user: { select: userSummarySelect } },
    orderBy: { createdAt: "asc" },
  },
  statusHistory: {
    include: { changedBy: { select: userSummarySelect } },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.MutantInclude;

export type MutantDetail = Prisma.MutantGetPayload<{ include: typeof mutantDetailInclude }>;

/** Fields needed for dataset exports (flattened by `toExportRow`). */
export const mutantExportSelect = {
  id: true,
  title: true,
  description: true,
  filePath: true,
  startLine: true,
  endLine: true,
  mutationOperator: true,
  originalCode: true,
  mutatedCode: true,
  gitDiff: true,
  reviewStatus: true,
  mutationStatus: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { githubOwner: true, githubRepository: true, language: true } },
  revision: { select: { commitSha: true } },
  pullRequest: { select: { number: true } },
  createdBy: { select: { githubUsername: true } },
  submissions: {
    select: {
      observedResult: true,
      buildCommand: true,
      testCommand: true,
      fuzzCommand: true,
      environmentDescription: true,
    },
    orderBy: { createdAt: "desc" },
    take: 1,
  },
  validations: { select: { result: true, killingTestRef: true } },
  killClaims: { select: { kind: true, reference: true, status: true } },
  toolName: true,
  importBatchId: true,
  importBatch: { select: { toolVersion: true } },
  driftStatus: true,
  driftCommitSha: true,
  driftLine: true,
} satisfies Prisma.MutantSelect;

export type MutantExportRecord = Prisma.MutantGetPayload<{ select: typeof mutantExportSelect }>;

export interface MutantListWhere {
  projectId?: string;
  language?: string;
  mutationOperator?: MutationOperator;
  reviewStatus?: ReviewStatus;
  reviewStatusIn?: ReviewStatus[];
  mutationStatus?: MutationStatus;
  createdByUsername?: string;
  createdById?: string;
  commitShaPrefix?: string;
  filePathContains?: string;
  createdSince?: Date;
  /** Exclusive upper bound on createdAt. */
  createdBefore?: Date;
  /** Restrict to a set of projects (reviewer scope). */
  projectIdIn?: string[];
  text?: string;
  importBatchId?: string;
  driftStatus?: DriftStatus;
  /** "hide": latest result per mutation only; "only": just the superseded ones. */
  superseded?: "hide" | "only";
}

export interface Page {
  page: number;
  pageSize: number;
}

export function buildMutantWhere(w: MutantListWhere): Prisma.MutantWhereInput {
  const and: Prisma.MutantWhereInput[] = [];
  if (w.projectId) and.push({ projectId: w.projectId });
  if (w.projectIdIn) and.push({ projectId: { in: w.projectIdIn } });
  if (w.language) and.push({ project: { language: { equals: w.language, mode: "insensitive" } } });
  if (w.mutationOperator) and.push({ mutationOperator: w.mutationOperator });
  if (w.reviewStatus) and.push({ reviewStatus: w.reviewStatus });
  if (w.reviewStatusIn) and.push({ reviewStatus: { in: w.reviewStatusIn } });
  if (w.mutationStatus) and.push({ mutationStatus: w.mutationStatus });
  if (w.createdById) and.push({ createdById: w.createdById });
  if (w.createdByUsername)
    and.push({
      createdBy: { githubUsername: { equals: w.createdByUsername, mode: "insensitive" } },
    });
  if (w.commitShaPrefix) and.push({ revision: { commitSha: { startsWith: w.commitShaPrefix } } });
  if (w.filePathContains)
    and.push({ filePath: { contains: w.filePathContains, mode: "insensitive" } });
  if (w.createdSince) and.push({ createdAt: { gte: w.createdSince } });
  if (w.createdBefore) and.push({ createdAt: { lt: w.createdBefore } });
  if (w.importBatchId) and.push({ importBatchId: w.importBatchId });
  if (w.driftStatus) and.push({ driftStatus: w.driftStatus });
  if (w.superseded) and.push({ superseded: w.superseded === "only" });
  if (w.text) {
    and.push({
      OR: [
        { title: { contains: w.text, mode: "insensitive" } },
        { description: { contains: w.text, mode: "insensitive" } },
        { originalCode: { contains: w.text, mode: "insensitive" } },
        { mutatedCode: { contains: w.text, mode: "insensitive" } },
        { filePath: { contains: w.text, mode: "insensitive" } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

export interface CreateMutantData {
  projectId: string;
  revisionId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  originalCode: string;
  mutatedCode: string;
  gitDiff: string;
  mutationOperator: MutationOperator;
  title: string;
  description: string | null;
  fingerprint: string;
  similarityKey: string | null;
  similarityKeyVersion: number;
  mutationStatus: MutationStatus;
  createdById: string;
  pullRequestId: string | null;
  submission: {
    buildCommand: string | null;
    testCommand: string;
    fuzzCommand: string | null;
    testDurationSeconds: number | null;
    environmentDescription: string | null;
    operatingSystem: string | null;
    compiler: string | null;
    observedResult: ObservedResult;
    notes: string | null;
    stdout: string | null;
    stderr: string | null;
  };
}

export const mutantRepository = {
  findDetail(id: number) {
    return prisma.mutant.findUnique({ where: { id }, include: mutantDetailInclude });
  },

  findListItem(id: number) {
    return prisma.mutant.findUnique({ where: { id }, select: mutantListSelect });
  },

  async list(where: MutantListWhere, page: Page, order: "asc" | "desc" = "desc") {
    const prismaWhere = buildMutantWhere(where);
    const [items, total] = await prisma.$transaction([
      prisma.mutant.findMany({
        where: prismaWhere,
        select: mutantListSelect,
        orderBy: { createdAt: order },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      prisma.mutant.count({ where: prismaWhere }),
    ]);
    return { items, total };
  },

  /** Mutants attached to one file at one revision (for gutter indicators). */
  listForFile(projectId: string, revisionId: string, filePath: string) {
    return prisma.mutant.findMany({
      where: { projectId, revisionId, filePath },
      select: mutantListSelect,
      orderBy: [{ startLine: "asc" }, { createdAt: "asc" }],
    });
  },

  /** Mutants for the same file at *other* revisions, so drift can be surfaced. */
  countForFileOtherRevisions(projectId: string, revisionId: string, filePath: string) {
    return prisma.mutant.count({
      where: { projectId, filePath, revisionId: { not: revisionId } },
    });
  },

  findByFingerprint(fingerprint: string) {
    return prisma.mutant.findMany({
      where: { fingerprint },
      select: mutantListSelect,
      orderBy: { createdAt: "asc" },
    });
  },

  /** Mutants whose similarity key predates `version`, grouped by commit and file. */
  listForSimilarityBackfill(version: number, take: number) {
    return prisma.mutant.findMany({
      where: { similarityKeyVersion: { lt: version } },
      select: {
        id: true,
        projectId: true,
        filePath: true,
        startLine: true,
        endLine: true,
        originalCode: true,
        mutatedCode: true,
        similarityKey: true,
        revision: { select: { commitSha: true } },
        project: { select: { githubOwner: true, githubRepository: true } },
      },
      orderBy: [{ revisionId: "asc" }, { filePath: "asc" }, { id: "asc" }],
      take,
    });
  },

  countForSimilarityBackfill(version: number) {
    return prisma.mutant.count({ where: { similarityKeyVersion: { lt: version } } });
  },

  /**
   * Stores recomputed similarity keys and refreshes the superseded flags of
   * both the groups the mutants left and the ones they joined.
   */
  async setSimilarityKeys(
    updates: Array<{
      id: number;
      previousKey: string | null;
      similarityKey: string | null;
      similarityKeyVersion: number;
    }>,
  ) {
    for (let i = 0; i < updates.length; i += 500) {
      const chunk = updates.slice(i, i + 500);
      await prisma.$transaction(
        async (tx) => {
          for (const u of chunk)
            await tx.mutant.update({
              where: { id: u.id },
              data: {
                similarityKey: u.similarityKey,
                similarityKeyVersion: u.similarityKeyVersion,
              },
            });
          await refreshSuperseded(
            tx,
            chunk.flatMap((u) => [u.previousKey, u.similarityKey]),
          );
        },
        { timeout: 120_000 },
      );
    }
  },

  /** The same mutation (equal similarity key) recorded at another commit. */
  findSameMutation(similarityKey: string, revisionId: string) {
    return prisma.mutant.findMany({
      where: { similarityKey, revisionId: { not: revisionId } },
      select: {
        id: true,
        mutationStatus: true,
        startLine: true,
        revision: { select: { commitSha: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  },

  /**
   * The same mutation at other commits: an equal similarity key (code pair plus
   * surrounding lines). Mutants at `revisionId` itself are never similar: the
   * same code at another line of one commit is a different mutant. With `text`
   * (the submission drawer), a substring match on the code columns is added so
   * partially typed snippets still surface candidates; an empty snippet only
   * matches an empty one, so a deletion does not match every mutant.
   */
  findSimilar(params: {
    projectId: string;
    filePath: string;
    revisionId?: string;
    similarityKey: string | null;
    text?: { originalCode: string; mutatedCode: string };
  }) {
    const original = params.text?.originalCode.trim();
    const mutated = params.text?.mutatedCode.trim();
    const or: Prisma.MutantWhereInput[] = [];
    if (params.similarityKey) or.push({ similarityKey: params.similarityKey });
    if (original)
      or.push({
        originalCode: { contains: original, mode: "insensitive" },
        mutatedCode: mutated ? { contains: mutated, mode: "insensitive" } : { equals: "" },
      });
    if (or.length === 0) return Promise.resolve([]);
    return prisma.mutant.findMany({
      where: {
        projectId: params.projectId,
        filePath: params.filePath,
        revisionId: params.revisionId ? { not: params.revisionId } : undefined,
        OR: or,
      },
      select: mutantListSelect,
      orderBy: { createdAt: "asc" },
      take: 10,
    });
  },

  /** Creates the mutant, its submission, the initial history rows and activity atomically. */
  create(data: CreateMutantData) {
    const { submission, ...mutant } = data;
    return prisma.$transaction(async (tx) => {
      const created = await tx.mutant.create({
        data: {
          ...mutant,
          submissions: { create: { ...submission, submittedById: data.createdById } },
          statusHistory: {
            create: [
              {
                kind: "REVIEW",
                previousValue: null,
                newValue: "PENDING",
                changedById: data.createdById,
              },
              {
                kind: "MUTATION",
                previousValue: null,
                newValue: data.mutationStatus,
                changedById: data.createdById,
                comment: "Initial result reported by the submitter",
              },
            ],
          },
        },
      });
      await refreshSuperseded(tx, [created.similarityKey]);
      await tx.activity.create({
        data: {
          type: "MUTANT_SUBMITTED",
          actorId: data.createdById,
          projectId: data.projectId,
          mutantId: created.id,
          payload: { title: data.title, filePath: data.filePath, startLine: data.startLine },
        },
      });
      await notificationRepository.recordInTx(tx, {
        type: "MUTANT_SUBMITTED",
        actorId: data.createdById,
        mutantId: created.id,
      });
      return created;
    });
  },

  /** Appends history + activity and updates the status in one transaction. */
  changeStatus(params: {
    mutantId: number;
    kind: StatusKind;
    previousValue: string;
    newValue: string;
    changedById: string;
    comment: string | null;
    activityType: ActivityType | null;
    projectId: string;
    duplicateOfId?: number | null;
  }) {
    const data: Prisma.MutantUpdateInput =
      params.kind === "REVIEW"
        ? {
            reviewStatus: params.newValue as ReviewStatus,
            duplicateOf:
              params.duplicateOfId === undefined
                ? undefined
                : params.duplicateOfId === null
                  ? { disconnect: true }
                  : { connect: { id: params.duplicateOfId } },
          }
        : params.kind === "MUTATION"
          ? { mutationStatus: params.newValue as MutationStatus }
          : {};

    return prisma.$transaction(async (tx) => {
      const updated = await tx.mutant.update({ where: { id: params.mutantId }, data });
      // Review and mutation status both decide whether this mutant supersedes its siblings.
      await refreshSuperseded(tx, [updated.similarityKey]);
      await tx.mutantStatusHistory.create({
        data: {
          mutantId: params.mutantId,
          kind: params.kind,
          previousValue: params.previousValue,
          newValue: params.newValue,
          changedById: params.changedById,
          comment: params.comment,
        },
      });
      if (params.activityType) {
        await tx.activity.create({
          data: {
            type: params.activityType,
            actorId: params.changedById,
            projectId: params.projectId,
            mutantId: params.mutantId,
            payload: {
              kind: params.kind,
              from: params.previousValue,
              to: params.newValue,
              comment: params.comment,
            },
          },
        });
        await notificationRepository.recordInTx(tx, {
          type: params.activityType,
          actorId: params.changedById,
          mutantId: params.mutantId,
          detail: params.comment,
        });
      }
      return updated;
    });
  },

  /** Files with the most mutants in a project. */
  topFiles(projectId: string, take = 8) {
    return prisma.mutant.groupBy({
      by: ["filePath"],
      where: { projectId },
      _count: { _all: true },
      orderBy: { _count: { filePath: "desc" } },
      take,
    });
  },

  /** Contributors ranked by number of mutants in a project. */
  topContributors(projectId: string, take = 8) {
    return prisma.mutant.groupBy({
      by: ["createdById"],
      where: { projectId },
      _count: { _all: true },
      orderBy: { _count: { createdById: "desc" } },
      take,
    });
  },

  /**
   * Applies a contributor edit: mutant fields are replaced, a NEW submission
   * row keeps the previous evidence, and a SUBMISSION history row lists what
   * changed. Location fields are never touched here.
   */
  updateSubmission(params: {
    mutantId: number;
    projectId: string;
    editedById: string;
    fields: Pick<
      CreateMutantData,
      | "title"
      | "mutationOperator"
      | "originalCode"
      | "mutatedCode"
      | "gitDiff"
      | "description"
      | "fingerprint"
      | "similarityKey"
      | "similarityKeyVersion"
    >;
    submission: CreateMutantData["submission"];
    changedFields: string[];
    editReason: string | null;
  }) {
    const summary = params.changedFields.length
      ? `Edited: ${params.changedFields.join(", ")}`
      : "Edited (no field changes)";
    const comment = params.editReason ? `${summary}. ${params.editReason}` : summary;
    return prisma.$transaction(async (tx) => {
      const before = await tx.mutant.findUniqueOrThrow({
        where: { id: params.mutantId },
        select: { similarityKey: true },
      });
      const updated = await tx.mutant.update({
        where: { id: params.mutantId },
        data: {
          ...params.fields,
          submissions: { create: { ...params.submission, submittedById: params.editedById } },
        },
      });
      // An edit can move the mutant to another similarity group or change its result.
      await refreshSuperseded(tx, [before.similarityKey, updated.similarityKey]);
      await tx.mutantStatusHistory.create({
        data: {
          mutantId: params.mutantId,
          kind: "SUBMISSION",
          previousValue: null,
          newValue: "EDITED",
          changedById: params.editedById,
          comment,
        },
      });
      await tx.activity.create({
        data: {
          type: "MUTANT_EDITED",
          actorId: params.editedById,
          projectId: params.projectId,
          mutantId: params.mutantId,
          payload: { changedFields: params.changedFields, reason: params.editReason },
        },
      });
      await notificationRepository.recordInTx(tx, {
        type: "MUTANT_EDITED",
        actorId: params.editedById,
        mutantId: params.mutantId,
        detail: params.editReason ?? summary,
      });
      return updated;
    });
  },

  /** Updates only the title or description, recording the change like any other edit. */
  updateText(params: {
    mutantId: number;
    projectId: string;
    editedById: string;
    fields: { title: string } | { description: string | null };
  }) {
    const field = "title" in params.fields ? "title" : "description";
    const summary = `Edited: ${field}`;
    return prisma.$transaction(async (tx) => {
      const updated = await tx.mutant.update({
        where: { id: params.mutantId },
        data: params.fields,
      });
      await tx.mutantStatusHistory.create({
        data: {
          mutantId: params.mutantId,
          kind: "SUBMISSION",
          previousValue: null,
          newValue: "EDITED",
          changedById: params.editedById,
          comment: summary,
        },
      });
      await tx.activity.create({
        data: {
          type: "MUTANT_EDITED",
          actorId: params.editedById,
          projectId: params.projectId,
          mutantId: params.mutantId,
          payload: { changedFields: [field], reason: null },
        },
      });
      await notificationRepository.recordInTx(tx, {
        type: "MUTANT_EDITED",
        actorId: params.editedById,
        mutantId: params.mutantId,
        detail: summary,
      });
      return updated;
    });
  },

  /** Streams matching mutants in id order, in batches, up to `limit` rows. */
  async *iterateForExport(
    where: MutantListWhere,
    limit: number,
    batchSize = 500,
  ): AsyncGenerator<MutantExportRecord[]> {
    const prismaWhere = buildMutantWhere(where);
    let cursor: number | undefined;
    let remaining = limit;
    while (remaining > 0) {
      const batch = await prisma.mutant.findMany({
        where: cursor ? { AND: [prismaWhere, { id: { gt: cursor } }] } : prismaWhere,
        select: mutantExportSelect,
        orderBy: { id: "asc" },
        take: Math.min(batchSize, remaining),
      });
      if (batch.length === 0) return;
      yield batch;
      remaining -= batch.length;
      cursor = batch[batch.length - 1].id;
      if (batch.length < batchSize) return;
    }
  },

  countPendingReview(projectIdIn: string[] | null) {
    return prisma.mutant.count({
      where: {
        reviewStatus: { in: ["PENDING", "NEEDS_INFORMATION"] },
        projectId: projectIdIn ? { in: projectIdIn } : undefined,
      },
    });
  },

  /** Approved mutants with the fewest reproductions, for the dashboard. */
  suggestedForReproduction(excludeUserId: string, take = 5) {
    return prisma.mutant.findMany({
      where: {
        reviewStatus: "APPROVED",
        mutationStatus: { in: ["SURVIVED", "UNKNOWN"] },
        createdById: { not: excludeUserId },
        validations: { none: { userId: excludeUserId } },
      },
      select: mutantListSelect,
      orderBy: [{ validations: { _count: "asc" } }, { createdAt: "desc" }],
      take,
    });
  },
};
