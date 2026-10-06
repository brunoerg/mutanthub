import "server-only";
import { prisma } from "@/server/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { RunRequestStatus } from "@/generated/prisma/enums";
import type { RunRequestEventType } from "@/domain/run-requests/notifications";
import { userSummarySelect } from "./user-repository";

const pullRequestSelect = {
  id: true,
  number: true,
  title: true,
  state: true,
  authorLogin: true,
  headSha: true,
  headRef: true,
  baseRef: true,
  htmlUrl: true,
  changedRanges: true,
} satisfies Prisma.PullRequestSelect;

export const runRequestListInclude = {
  pullRequest: { select: pullRequestSelect },
  requestedBy: { select: userSummarySelect },
  claims: {
    select: {
      id: true,
      status: true,
      expiresAt: true,
      commitSha: true,
      userId: true,
      user: { select: userSummarySelect },
    },
    orderBy: { createdAt: "asc" },
  },
  _count: { select: { votes: true } },
} satisfies Prisma.RunRequestInclude;

export const runRequestDetailInclude = {
  project: true,
  pullRequest: { select: pullRequestSelect },
  requestedBy: { select: userSummarySelect },
  closedBy: { select: userSummarySelect },
  claims: { include: { user: { select: userSummarySelect } }, orderBy: { createdAt: "asc" } },
  votes: { select: { userId: true, user: { select: userSummarySelect } } },
} satisfies Prisma.RunRequestInclude;

export type RunRequestListItem = Prisma.RunRequestGetPayload<{
  include: typeof runRequestListInclude;
}>;
export type RunRequestDetail = Prisma.RunRequestGetPayload<{
  include: typeof runRequestDetailInclude;
}>;

export interface RunClaimReportData {
  commitSha: string;
  toolName: string;
  toolVersion: string | null;
  command: string | null;
  generated: number;
  killed: number;
  survived: number;
  durationSeconds: number | null;
  environment: string | null;
  notes: string | null;
}

export const runRequestRepository = {
  listForProject(projectId: string, opts: { open?: boolean; take?: number } = {}) {
    return prisma.runRequest.findMany({
      where: {
        projectId,
        status: opts.open === undefined ? undefined : opts.open ? "OPEN" : { not: "OPEN" },
      },
      include: runRequestListInclude,
      orderBy: { createdAt: "desc" },
      take: opts.take ?? 100,
    });
  },

  countOpenForProject(projectId: string) {
    return prisma.runRequest.count({ where: { projectId, status: "OPEN" } });
  },

  listForPullRequest(pullRequestId: string) {
    return prisma.runRequest.findMany({
      where: { pullRequestId },
      include: runRequestListInclude,
      orderBy: { createdAt: "desc" },
    });
  },

  findById(id: string) {
    return prisma.runRequest.findUnique({ where: { id }, include: runRequestDetailInclude });
  },

  findOpenForPullRequest(pullRequestId: string) {
    return prisma.runRequest.findFirst({ where: { pullRequestId, status: "OPEN" } });
  },

  countOpenByUser(userId: string) {
    return prisma.runRequest.count({ where: { requestedById: userId, status: "OPEN" } });
  },

  /**
   * Returns null when the pull request already has an open request (a
   * concurrent create won the partial unique index on open requests).
   */
  async create(data: {
    projectId: string;
    pullRequestId: string;
    requestedById: string;
    headSha: string;
    files: string[];
    notes: string | null;
  }) {
    try {
      return await prisma.runRequest.create({ data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return null;
      throw e;
    }
  },

  retarget(id: string, headSha: string) {
    return prisma.runRequest.update({ where: { id }, data: { headSha } });
  },

  close(
    id: string,
    data: {
      status: Exclude<RunRequestStatus, "OPEN">;
      closedById: string | null;
      reason: string | null;
    },
  ) {
    return prisma.runRequest.update({
      where: { id },
      data: {
        status: data.status,
        closedById: data.closedById,
        closeReason: data.reason,
        closedAt: new Date(),
      },
    });
  },

  /** Closes every open request of a pull request (it was merged or closed). */
  closeOpenForPullRequest(pullRequestId: string, reason: string) {
    return prisma.runRequest.updateMany({
      where: { pullRequestId, status: "OPEN" },
      data: { status: "CLOSED", closeReason: reason, closedAt: new Date() },
    });
  },

  async setVote(requestId: string, userId: string, on: boolean) {
    if (on) {
      await prisma.runRequestVote.upsert({
        where: { requestId_userId: { requestId, userId } },
        create: { requestId, userId },
        update: {},
      });
    } else {
      await prisma.runRequestVote.deleteMany({ where: { requestId, userId } });
    }
  },

  findActiveClaim(requestId: string, userId: string) {
    return prisma.runClaim.findFirst({
      where: { requestId, userId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
    });
  },

  createClaim(data: { requestId: string; userId: string; expiresAt: Date }) {
    return prisma.runClaim.create({ data });
  },

  extendClaim(id: string, expiresAt: Date) {
    return prisma.runClaim.update({ where: { id }, data: { expiresAt } });
  },

  abandonClaim(id: string) {
    return prisma.runClaim.update({ where: { id }, data: { status: "ABANDONED" } });
  },

  /** Turns the runner's active claim into a report, or records a report without a claim. */
  report(requestId: string, userId: string, claimId: string | null, data: RunClaimReportData) {
    const fields = { ...data, status: "REPORTED" as const, reportedAt: new Date() };
    if (claimId) return prisma.runClaim.update({ where: { id: claimId }, data: fields });
    return prisma.runClaim.create({
      data: { requestId, userId, expiresAt: new Date(), ...fields },
    });
  },

  /** Everyone who may be notified about a request (see runRequestRecipients). */
  async participants(requestId: string) {
    const request = await prisma.runRequest.findUnique({
      where: { id: requestId },
      select: {
        requestedById: true,
        projectId: true,
        pullRequest: { select: { authorLogin: true } },
        votes: { select: { userId: true } },
        claims: { select: { userId: true }, distinct: ["userId"] },
      },
    });
    if (!request) return null;
    const [followers, reviewers, prAuthor] = await Promise.all([
      prisma.projectFollow.findMany({
        where: { projectId: request.projectId },
        select: { userId: true },
      }),
      prisma.projectMember.findMany({
        where: { projectId: request.projectId, role: { in: ["REVIEWER", "MAINTAINER"] } },
        select: { userId: true },
      }),
      request.pullRequest.authorLogin
        ? prisma.user.findUnique({
            where: { githubUsername: request.pullRequest.authorLogin },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    return {
      requesterId: request.requestedById,
      voterIds: request.votes.map((v) => v.userId),
      runnerIds: request.claims.map((c) => c.userId),
      watcherIds: [...followers, ...reviewers].map((r) => r.userId),
      prAuthorId: prAuthor?.id ?? null,
    };
  },

  /** Feed entry plus inbox fan-out, written together so they never diverge. */
  recordEvent(data: {
    type: RunRequestEventType;
    actorId: string;
    projectId: string;
    requestId: string;
    payload: Prisma.InputJsonObject;
    notifications: Array<{ userId: string; title: string; body: string | null }>;
  }) {
    return prisma.$transaction(async (tx) => {
      await tx.activity.create({
        data: {
          type: data.type,
          actorId: data.actorId,
          projectId: data.projectId,
          payload: { ...data.payload, requestId: data.requestId },
        },
      });
      if (data.notifications.length === 0) return;
      await tx.notification.createMany({
        data: data.notifications.map((n) => ({
          userId: n.userId,
          type: data.type,
          actorId: data.actorId,
          projectId: data.projectId,
          runRequestId: data.requestId,
          title: n.title,
          body: n.body,
        })),
      });
    });
  },
};
