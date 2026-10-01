import "server-only";
import { prisma } from "@/server/db/prisma";
import type { Prisma } from "@/generated/prisma/client";

export interface GitHubIdentity {
  githubId: string;
  githubUsername: string;
  displayName: string;
  avatarUrl: string | null;
  email: string | null;
}

export const userSummarySelect = {
  id: true,
  githubUsername: true,
  displayName: true,
  avatarUrl: true,
  globalRole: true,
} satisfies Prisma.UserSelect;

export type UserSummary = Prisma.UserGetPayload<{ select: typeof userSummarySelect }>;

/**
 * Every column referencing a user besides ProjectMember and ProjectFollow,
 * which have unique keys and are merged separately. Mirrors the
 * case_insensitive_username migration; keep both in sync with the schema.
 */
const USER_REFERENCES = [
  ["Project", "addedById"],
  ["Mutant", "createdById"],
  ["Submission", "submittedById"],
  ["Validation", "userId"],
  ["Comment", "userId"],
  ["MutantStatusHistory", "changedById"],
  ["Activity", "actorId"],
  ["Notification", "userId"],
  ["Notification", "actorId"],
  ["AuditLog", "actorId"],
  ["DatasetSnapshot", "createdById"],
  ["KillClaim", "claimedById"],
  ["KillClaim", "resolvedById"],
  ["ImportBatch", "importedById"],
] as const;

/** Moves everything a placeholder owns onto `toId`, then deletes it. */
async function mergePlaceholder(tx: Prisma.TransactionClient, fromId: string, toId: string) {
  // Keep the highest role per project.
  await tx.$executeRaw`
    INSERT INTO "ProjectMember" (id, "projectId", "userId", role, "createdAt")
    SELECT gen_random_uuid()::text, "projectId", ${toId}, role, "createdAt"
    FROM "ProjectMember" WHERE "userId" = ${fromId}
    ON CONFLICT ("projectId", "userId")
    DO UPDATE SET role = GREATEST("ProjectMember".role, EXCLUDED.role)`;
  await tx.$executeRaw`
    INSERT INTO "ProjectFollow" ("projectId", "userId", "createdAt")
    SELECT "projectId", ${toId}, "createdAt"
    FROM "ProjectFollow" WHERE "userId" = ${fromId}
    ON CONFLICT DO NOTHING`;
  for (const [table, column] of USER_REFERENCES) {
    // Identifiers come from the constant above, never from input.
    await tx.$executeRawUnsafe(
      `UPDATE "${table}" SET "${column}" = $1 WHERE "${column}" = $2`,
      toId,
      fromId,
    );
  }
  await tx.$executeRaw`
    UPDATE "AuditLog" SET "targetId" = ${toId}
    WHERE "targetType" = 'member' AND "targetId" = ${fromId}`;
  // Only the merged memberships and follows are left to cascade.
  await tx.user.delete({ where: { id: fromId } });
}

export const userRepository = {
  findById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  },

  findByUsername(githubUsername: string) {
    return prisma.user.findUnique({ where: { githubUsername } });
  },

  /** Identity + memberships in a single query, used to build the Principal. */
  findPrincipalById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        ...userSummarySelect,
        email: true,
        memberships: { select: { projectId: true, role: true } },
      },
    });
  },

  /** Creates or refreshes a user from a GitHub OAuth profile. */
  async upsertFromGitHub(identity: GitHubIdentity) {
    const existing = await prisma.user.findUnique({ where: { githubId: identity.githubId } });
    if (existing) {
      return prisma.$transaction(async (tx) => {
        // After a GitHub rename, a placeholder may already hold the new name
        // (in any casing): fold it into this account so the name is free.
        const holder = await tx.user.findUnique({
          where: { githubUsername: identity.githubUsername },
        });
        if (holder && holder.id !== existing.id && !holder.githubId) {
          await mergePlaceholder(tx, holder.id, existing.id);
        }
        return tx.user.update({
          where: { id: existing.id },
          data: {
            githubUsername: identity.githubUsername,
            displayName: identity.displayName,
            avatarUrl: identity.avatarUrl,
            email: identity.email ?? existing.email,
            ...(holder?.globalRole === "ADMIN" && !holder.githubId && { globalRole: "ADMIN" }),
          },
        });
      });
    }
    // A seed user may exist with the same username but no GitHub id: claim it.
    const byUsername = await prisma.user.findUnique({
      where: { githubUsername: identity.githubUsername },
    });
    if (byUsername && !byUsername.githubId) {
      return prisma.user.update({
        where: { id: byUsername.id },
        data: {
          githubId: identity.githubId,
          githubUsername: identity.githubUsername,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
          email: identity.email ?? byUsername.email,
        },
      });
    }
    return prisma.user.create({
      data: {
        githubId: identity.githubId,
        githubUsername: identity.githubUsername,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        email: identity.email,
      },
    });
  },

  /**
   * Finds a user by username or creates a placeholder account for it. Used by
   * the mocked login and by maintainers adding members who have not signed in
   * yet; the placeholder is claimed on the user's first GitHub sign-in.
   */
  async findOrCreateByUsername(githubUsername: string) {
    const existing = await prisma.user.findUnique({ where: { githubUsername } });
    if (existing) return existing;
    return prisma.user.create({
      data: {
        githubUsername,
        displayName: githubUsername,
        avatarUrl: `https://avatars.githubusercontent.com/${encodeURIComponent(githubUsername)}`,
      },
    });
  },

  /** Grants the global ADMIN role (idempotent). */
  async promoteToAdmin(userId: string) {
    return prisma.user.update({ where: { id: userId }, data: { globalRole: "ADMIN" } });
  },

  /** Dev-only alias kept for the mocked login. */
  findOrCreateMockUser(githubUsername: string) {
    return this.findOrCreateByUsername(githubUsername);
  },

  listMockLoginUsers() {
    return prisma.user.findMany({
      select: {
        ...userSummarySelect,
        memberships: { select: { role: true, project: { select: { displayName: true } } } },
      },
      orderBy: { createdAt: "asc" },
      take: 50,
    });
  },

  searchByUsername(query: string, take = 10) {
    return prisma.user.findMany({
      where: {
        OR: [
          { githubUsername: { contains: query, mode: "insensitive" } },
          { displayName: { contains: query, mode: "insensitive" } },
        ],
      },
      select: userSummarySelect,
      take,
    });
  },

  /** Usernames of everyone who created at least one mutant (optionally in one project). */
  async listMutantContributors(projectId?: string) {
    const users = await prisma.user.findMany({
      where: { mutants: { some: projectId ? { projectId } : {} } },
      select: { githubUsername: true },
      orderBy: { githubUsername: "asc" },
    });
    return users.map((u) => u.githubUsername);
  },
};
