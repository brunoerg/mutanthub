import "server-only";
import type { Principal } from "@/domain/auth/permissions";
import { canManageProject, canRegisterProject } from "@/domain/auth/permissions";
import { AppError, conflict, forbidden, notFound, validationError } from "@/lib/errors";
import { enforceRateLimit, RATE_LIMITS } from "@/server/infra/rate-limit";
import {
  addMemberSchema,
  changeMemberRoleSchema,
  fieldErrors,
  registerProjectSchema,
  removeMemberSchema,
  setProjectActiveSchema,
} from "@/lib/validation/schemas";
import { userRepository } from "@/server/repositories/user-repository";
import { auditRepository } from "@/server/repositories/audit-repository";
import { getGitHubClient } from "@/server/github";
import { createTokenProvider, githubAppInstallUrl } from "@/server/github/app-auth";
import { env } from "@/server/env";
import { isGitHubError, type CommitInfo } from "@/server/github/types";
import { projectRepository } from "@/server/repositories/project-repository";
import {
  activityRepository,
  validationRepository,
} from "@/server/repositories/interaction-repository";
import { mutantRepository } from "@/server/repositories/mutant-repository";
import { driftRepository } from "@/server/repositories/drift-repository";
import { statsRepository } from "@/server/repositories/stats-repository";
import type { Project, Revision } from "@/generated/prisma/client";

export const projectService = {
  async getBySlugOrThrow(owner: string, repo: string): Promise<Project> {
    const project = await projectRepository.findBySlug(owner, repo);
    if (!project) throw notFound("Project");
    return project;
  },

  listProjects() {
    return projectRepository.listWithStats({ activeOnly: true });
  },

  /**
   * Registers a GitHub repository. Metadata comes from GitHub (or the mock),
   * so a project always mirrors a real repository.
   */
  async registerProject(principal: Principal | null, rawInput: unknown): Promise<Project> {
    if (!principal) throw forbidden("Sign in to register a project");
    if (!canRegisterProject(principal, env.projectRegistration))
      throw forbidden("Only administrators can register projects on this server");
    const parsed = registerProjectSchema.safeParse(rawInput);
    if (!parsed.success)
      throw validationError("Invalid repository", { repository: "Use owner/repository" });
    await enforceRateLimit({
      ...RATE_LIMITS.registerProject,
      action: "register-project",
      subject: principal.id,
    });

    const [owner, repo] = parsed.data.repository.split("/");
    const existing = await projectRepository.findBySlug(owner, repo);
    if (existing)
      throw conflict(`${existing.githubOwner}/${existing.githubRepository} is already registered`);

    let info;
    try {
      info = await getGitHubClient().getRepository(owner, repo);
    } catch (e) {
      if (isGitHubError(e) && e.kind === "NOT_FOUND")
        throw validationError("Repository not found on GitHub", {
          repository: "Repository not found",
        });
      throw new AppError("UPSTREAM", "GitHub is unavailable right now. Try again later.");
    }
    if (info.isPrivate)
      throw validationError("Only public repositories can be registered", {
        repository: "Repository is private",
      });

    const project = await projectRepository.create({
      githubOwner: info.owner,
      githubRepository: info.name,
      githubRepositoryId: info.id,
      displayName: info.fullName,
      description: info.description,
      defaultBranch: info.defaultBranch,
      language: info.language,
      addedById: principal.id,
    });
    // The registrant becomes a maintainer so the project has someone who can review.
    await projectRepository.upsertMember(project.id, principal.id, "MAINTAINER");
    await auditRepository.record({
      actorId: principal.id,
      action: "PROJECT_REGISTERED",
      projectId: project.id,
      targetType: "project",
      targetId: project.id,
      metadata: { repository: `${project.githubOwner}/${project.githubRepository}` },
    });
    return project;
  },

  /**
   * Resolves a ref (branch, tag or SHA) through GitHub and makes sure a
   * Revision row exists for it. Mutants always reference the returned row.
   */
  async ensureRevision(
    project: Project,
    ref: string,
  ): Promise<{ revision: Revision; commit: CommitInfo }> {
    const commit = await getGitHubClient().getCommit(
      project.githubOwner,
      project.githubRepository,
      ref,
    );
    const revision = await projectRepository.upsertRevision({
      projectId: project.id,
      commitSha: commit.sha,
      branch: ref === commit.sha || ref.startsWith(commit.sha.slice(0, 7)) ? undefined : ref,
      commitMessage: commit.message.split("\n")[0]?.slice(0, 500) ?? null,
      author: commit.authorLogin ?? commit.authorName,
      commitDate: commit.date,
    });
    return { revision, commit };
  },

  /** Head commit of the default branch (used to detect commit drift). */
  async getHeadCommit(project: Project): Promise<CommitInfo | null> {
    try {
      return await getGitHubClient().getCommit(
        project.githubOwner,
        project.githubRepository,
        project.defaultBranch,
      );
    } catch {
      return null;
    }
  },

  async getOverview(project: Project) {
    const [
      counts,
      latestSurviving,
      topFiles,
      topContributors,
      recentMutants,
      recentValidations,
      recentActivity,
      revisions,
      members,
      drift,
    ] = await Promise.all([
      statsRepository.countsForProject(project.id),
      statsRepository.countLatestSurvivingForProject(project.id),
      statsRepository.topFilesForProject(project.id),
      statsRepository.topContributorsForProject(project.id),
      mutantRepository.list({ projectId: project.id }, { page: 1, pageSize: 6 }),
      validationRepository.listRecentForProject(project.id, 6),
      activityRepository.listRecent({ projectId: project.id, take: 10 }),
      projectRepository.listRevisionsWithMutants(project.id),
      projectRepository.listMembers(project.id),
      driftRepository.countsForProject(project.id),
    ]);
    return {
      counts,
      latestSurviving,
      drift,
      topFiles,
      topContributors,
      recentMutants: recentMutants.items,
      recentValidations,
      recentActivity,
      revisions,
      members,
    };
  },

  // ---------------------------------------------------------------------------
  // Maintainer settings
  // ---------------------------------------------------------------------------

  async getSettings(principal: Principal | null, project: Project) {
    if (!canManageProject(principal, project.id))
      throw forbidden("Only maintainers can manage this project");
    const [members, maintainers, audit] = await Promise.all([
      projectRepository.listMembers(project.id),
      projectRepository.countMaintainers(project.id),
      auditRepository.listForProject(project.id),
    ]);
    return { members, maintainers, audit };
  },

  /** Adds a member by GitHub username. Users who never signed in are created as placeholders. */
  async addMember(principal: Principal | null, rawInput: unknown) {
    const parsed = addMemberSchema.safeParse(rawInput);
    if (!parsed.success) throw validationError("Invalid member", fieldErrors(parsed.error));
    const { projectId, username, role } = parsed.data;
    if (!canManageProject(principal, projectId))
      throw forbidden("Only maintainers can manage members");
    const project = await projectRepository.findById(projectId);
    if (!project) throw notFound("Project");

    let user = await userRepository.findByUsername(username);
    if (!user) {
      // Placeholder account: claimed automatically when this GitHub user signs in.
      user = await userRepository.findOrCreateByUsername(username);
    }
    const existing = await projectRepository.findMember(projectId, user.id);
    if (existing)
      throw conflict(`@${username} is already a ${existing.role.toLowerCase()} of this project`);
    await projectRepository.upsertMember(projectId, user.id, role);
    await auditRepository.record({
      actorId: principal!.id,
      action: "MEMBER_ADDED",
      projectId,
      targetType: "member",
      targetId: user.id,
      metadata: { username: user.githubUsername, role },
    });
    return { userId: user.id, username: user.githubUsername, role };
  },

  async changeMemberRole(principal: Principal | null, rawInput: unknown) {
    const parsed = changeMemberRoleSchema.safeParse(rawInput);
    if (!parsed.success) throw validationError("Invalid request", fieldErrors(parsed.error));
    const { projectId, userId, role } = parsed.data;
    if (!canManageProject(principal, projectId))
      throw forbidden("Only maintainers can manage members");
    const member = await projectRepository.findMember(projectId, userId);
    if (!member) throw notFound("Member");
    if (member.role === role) return member;
    if (member.role === "MAINTAINER") await assertNotLastMaintainer(projectId);
    const updated = await projectRepository.upsertMember(projectId, userId, role);
    await auditRepository.record({
      actorId: principal!.id,
      action: "MEMBER_ROLE_CHANGED",
      projectId,
      targetType: "member",
      targetId: userId,
      metadata: { from: member.role, to: role },
    });
    return updated;
  },

  async removeMember(principal: Principal | null, rawInput: unknown) {
    const parsed = removeMemberSchema.safeParse(rawInput);
    if (!parsed.success) throw validationError("Invalid request", fieldErrors(parsed.error));
    const { projectId, userId } = parsed.data;
    if (!canManageProject(principal, projectId))
      throw forbidden("Only maintainers can manage members");
    const member = await projectRepository.findMember(projectId, userId);
    if (!member) throw notFound("Member");
    if (member.role === "MAINTAINER") await assertNotLastMaintainer(projectId);
    await projectRepository.removeMember(projectId, userId);
    await auditRepository.record({
      actorId: principal!.id,
      action: "MEMBER_REMOVED",
      projectId,
      targetType: "member",
      targetId: userId,
      metadata: { role: member.role },
    });
    return { userId };
  },

  /** Inactive projects stay readable but stop accepting submissions and leave the lists. */
  async setActive(principal: Principal | null, rawInput: unknown) {
    const parsed = setProjectActiveSchema.safeParse(rawInput);
    if (!parsed.success) throw validationError("Invalid request", fieldErrors(parsed.error));
    const { projectId, isActive } = parsed.data;
    if (!canManageProject(principal, projectId))
      throw forbidden("Only maintainers can change this");
    return projectRepository.update(projectId, { isActive });
  },

  /** Re-reads description, default branch and language from GitHub. */
  async refreshFromGitHub(principal: Principal | null, projectId: string) {
    if (!canManageProject(principal, projectId))
      throw forbidden("Only maintainers can change this");
    const project = await projectRepository.findById(projectId);
    if (!project) throw notFound("Project");
    let info;
    try {
      info = await getGitHubClient().getRepository(project.githubOwner, project.githubRepository);
    } catch (e) {
      if (isGitHubError(e) && e.kind === "NOT_FOUND") throw notFound("Repository on GitHub");
      throw new AppError("UPSTREAM", "GitHub is unavailable right now. Try again later.");
    }
    const updated = await projectRepository.update(projectId, {
      displayName: info.fullName,
      description: info.description,
      defaultBranch: info.defaultBranch,
      language: info.language,
      githubRepositoryId: info.id,
    });
    await auditRepository.record({
      actorId: principal!.id,
      action: "PROJECT_REFRESHED",
      projectId,
      targetType: "project",
      targetId: projectId,
      metadata: { defaultBranch: info.defaultBranch, language: info.language },
    });
    return updated;
  },

  /** How repository reads are authenticated for this project (settings page). */
  async getGitHubAccess(project: Project) {
    if (env.resolvedGithubMode === "mock") {
      return {
        mode: "mock" as const,
        source: "mock" as const,
        appConfigured: false,
        installUrl: null,
        userTokens: false,
      };
    }
    const source = await createTokenProvider().describe(
      project.githubOwner,
      project.githubRepository,
    );
    return {
      mode: "live" as const,
      source,
      appConfigured: env.githubAppConfigured,
      installUrl: githubAppInstallUrl({ owner: project.githubOwner }),
      userTokens: env.githubOAuthConfigured,
    };
  },

  async setFollowing(principal: Principal | null, projectId: string, following: boolean) {
    if (!principal) throw forbidden("Sign in to follow projects");
    if (following) await projectRepository.follow(projectId, principal.id);
    else await projectRepository.unfollow(projectId, principal.id);
  },

  isFollowing(principal: Principal | null, projectId: string) {
    if (!principal) return Promise.resolve(false);
    return projectRepository.isFollowing(projectId, principal.id);
  },
};

async function assertNotLastMaintainer(projectId: string): Promise<void> {
  const maintainers = await projectRepository.countMaintainers(projectId);
  if (maintainers <= 1)
    throw validationError("A project needs at least one maintainer. Promote someone else first.");
}
