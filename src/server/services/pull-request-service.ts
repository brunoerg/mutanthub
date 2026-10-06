import "server-only";
import type { Principal } from "@/domain/auth/permissions";
import { buildCheckSummary, type CheckMutant } from "@/domain/pull-requests/check-summary";
import {
  countChangedLines,
  mutantTouchesDiff,
  parseChangedRanges,
  type ChangedRanges,
} from "@/domain/pull-requests/diff-ranges";
import { AppError, forbidden, notFound, validationError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import {
  fieldErrors,
  pullRequestMutantFilterSchema,
  trackPullRequestSchema,
} from "@/lib/validation/schemas";
import { filterPullRequestMutants } from "@/domain/pull-requests/mutant-filter";
import { enforceRateLimit } from "@/server/infra/rate-limit";
import { getGitHubClient } from "@/server/github";
import { isGitHubError } from "@/server/github/types";
import { publishCheckRun } from "@/server/github/check-run";
import { projectRepository } from "@/server/repositories/project-repository";
import { pullRequestRepository } from "@/server/repositories/pull-request-repository";
import { killClaimRepository } from "@/server/repositories/kill-claim-repository";
import { runRequestRepository } from "@/server/repositories/run-request-repository";
import type { Project } from "@/generated/prisma/client";
import { env } from "@/server/env";

function appBaseUrl(): string {
  return (process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export const pullRequestService = {
  /**
   * Fetches the pull request and its changed files from GitHub, upserts the
   * record, and makes sure the head commit exists as a Revision linked to it.
   */
  async sync(project: Project, number: number) {
    const client = getGitHubClient();
    let info;
    let files;
    try {
      [info, files] = await Promise.all([
        client.getPullRequest(project.githubOwner, project.githubRepository, number),
        client.getPullRequestFiles(project.githubOwner, project.githubRepository, number),
      ]);
    } catch (e) {
      if (isGitHubError(e) && e.kind === "NOT_FOUND")
        throw validationError(`Pull request #${number} was not found on GitHub`, {
          number: "Not found",
        });
      if (isGitHubError(e) && e.kind === "RATE_LIMITED")
        throw new AppError("UPSTREAM", "GitHub rate limit reached. Please try again later.");
      throw e;
    }

    const changedRanges: ChangedRanges = {};
    for (const f of files) if (f.changedRanges.length) changedRanges[f.path] = f.changedRanges;

    const pr = await pullRequestRepository.upsert({
      projectId: project.id,
      number: info.number,
      title: info.title,
      authorLogin: info.authorLogin,
      state: info.state,
      baseRef: info.baseRef,
      baseSha: info.baseSha,
      headRef: info.headRef,
      headSha: info.headSha,
      htmlUrl: info.htmlUrl,
      changedRanges,
      changedFiles: files.length,
      additions: info.additions,
      deletions: info.deletions,
    });
    if (info.state !== "OPEN")
      await runRequestRepository.closeOpenForPullRequest(
        pr.id,
        `Pull request ${info.state === "MERGED" ? "merged" : "closed"}`,
      );

    // The head commit becomes a Revision so mutants can point at this exact state.
    const head = await client.getCommit(
      project.githubOwner,
      project.githubRepository,
      info.headSha,
    );
    const revision = await projectRepository.upsertRevision({
      projectId: project.id,
      commitSha: head.sha,
      branch: info.headRef,
      commitMessage: head.message.split("\n")[0]?.slice(0, 500) ?? null,
      author: head.authorLogin ?? head.authorName,
      commitDate: head.date,
    });
    await pullRequestRepository.attachRevision(revision.id, pr.id);

    void this.refreshCheckRun(pr.id).catch((error) =>
      console.error("[check-run] refresh failed", (error as Error).message),
    );
    return pr;
  },

  /** Starts tracking a PR from the UI. Any signed-in user may track; data is public. */
  async track(principal: Principal | null, rawInput: unknown) {
    if (!principal) throw forbidden("Sign in to track a pull request");
    const parsed = trackPullRequestSchema.safeParse(rawInput);
    if (!parsed.success) throw validationError("Invalid pull request", fieldErrors(parsed.error));
    const project = await projectRepository.findById(parsed.data.projectId);
    if (!project || !project.isActive) throw notFound("Project");
    await enforceRateLimit({
      action: "track-pull-request",
      subject: principal.id,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    return this.sync(project, parsed.data.number);
  },

  list(project: Project) {
    return pullRequestRepository.listForProject(project.id);
  },

  /**
   * The PR, its changed files and its mutants split by diff. Stats and file
   * counts use the current results (superseded mutants left out, as in the
   * check run); `onDiff` / `offDiff` are narrowed by the page filters.
   */
  async getDetail(project: Project, number: number, rawFilter: unknown = {}) {
    const pr = await pullRequestRepository.findByNumber(project.id, number);
    if (!pr) throw notFound("Pull request");
    const parsed = pullRequestMutantFilterSchema.safeParse(rawFilter);
    const filter = parsed.success ? parsed.data : {};
    const changed = parseChangedRanges(pr.changedRanges);
    const mutants = await pullRequestRepository.listMutants(pr.id);
    const touches = (m: (typeof mutants)[number]) => mutantTouchesDiff(m, changed);
    const current = mutants.filter((m) => !m.superseded);
    const currentOnDiff = current.filter(touches);
    const files = Object.entries(changed)
      .map(([path, ranges]) => ({
        path,
        ranges,
        changedLines: countChangedLines(ranges),
        mutants: currentOnDiff.filter((m) => m.filePath === path).length,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const filtered = filterPullRequestMutants(mutants, filter);
    return {
      pr,
      changed,
      files,
      filter,
      stats: {
        onDiff: currentOnDiff.length,
        surviving: currentOnDiff.filter((m) => m.mutationStatus === "SURVIVED").length,
        killed: currentOnDiff.filter((m) => m.mutationStatus === "KILLED").length,
        pending: currentOnDiff.filter(
          (m) => m.reviewStatus === "PENDING" || m.reviewStatus === "NEEDS_INFORMATION",
        ).length,
        superseded: mutants.length - current.length,
      },
      totals: {
        onDiff: mutants.filter(touches).length,
        offDiff: mutants.filter((m) => !touches(m)).length,
      },
      onDiff: filtered.filter(touches),
      offDiff: filtered.filter((m) => !touches(m)),
      /** Every file with a mutant or a change, for the file filter. */
      filePaths: [...new Set([...Object.keys(changed), ...mutants.map((m) => m.filePath)])].sort(),
    };
  },

  /** Changed ranges for one file at the PR head, for the code browser's PR mode. */
  async getFileContext(project: Project, number: number, filePath: string) {
    const pr = await pullRequestRepository.findByNumber(project.id, number);
    if (!pr) return null;
    const changed = parseChangedRanges(pr.changedRanges);
    return {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      headSha: pr.headSha,
      state: pr.state,
      htmlUrl: pr.htmlUrl,
      ranges: changed[filePath] ?? [],
      fileInDiff: filePath in changed,
    };
  },

  /** Resolves a PR number to its id for mutant submissions, ensuring it belongs to the project. */
  async resolveIdForProject(projectId: string, number: number | undefined): Promise<string | null> {
    if (!number) return null;
    const pr = await pullRequestRepository.findByNumber(projectId, number);
    return pr?.id ?? null;
  },

  /** Recomputes and publishes the GitHub check run for the PR (no-op without the app). */
  async refreshCheckRun(pullRequestId: string): Promise<void> {
    const pr = await pullRequestRepository.findById(pullRequestId);
    if (!pr) return;
    if (env.resolvedGithubMode !== "live" || !env.githubAppConfigured) return;
    const changed = parseChangedRanges(pr.changedRanges);
    const mutants = await pullRequestRepository.listMutants(pr.id);
    const checkMutants: CheckMutant[] = mutants.map((m) => ({
      id: m.id,
      title: m.title,
      filePath: m.filePath,
      startLine: m.startLine,
      endLine: m.endLine,
      reviewStatus: m.reviewStatus,
      mutationStatus: m.mutationStatus,
      validations: m._count.validations,
      commitSha: m.revision.commitSha,
      superseded: m.superseded,
    }));
    const base = appBaseUrl();
    const claims = await killClaimRepository.listForPullRequest(pr.id);
    const summary = buildCheckSummary(
      pr,
      checkMutants,
      changed,
      base,
      claims.map((c) => ({
        mutantId: c.mutantId,
        mutantTitle: c.mutant.title,
        status: c.status,
        applies: c.applies,
      })),
    );
    const id = await publishCheckRun({
      owner: pr.project.githubOwner,
      repo: pr.project.githubRepository,
      headSha: pr.headSha,
      summary,
      detailsUrl: `${base}${routes.projectPull(pr.project.githubOwner, pr.project.githubRepository, pr.number)}`,
      checkRunId: pr.checkRunId,
    });
    if (id && id !== pr.checkRunId) await pullRequestRepository.recordCheckRun(pr.id, id);
  },

  /** Refreshes the check run for a mutant's PR, if any (called after mutant events). */
  async refreshForMutant(mutant: { pullRequestId: string | null }): Promise<void> {
    if (!mutant.pullRequestId) return;
    await this.refreshCheckRun(mutant.pullRequestId).catch((error) =>
      console.error("[check-run] refresh failed", (error as Error).message),
    );
  },
};
