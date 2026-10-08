import "server-only";
import type { Principal } from "@/domain/auth/permissions";
import { canReviewProject } from "@/domain/auth/permissions";
import { locateOriginalCode } from "@/domain/kill-claims/applies";
import {
  looksLikeTestPath,
  parseKillReference,
  referenceLabel,
} from "@/domain/kill-claims/reference";
import { evaluateClaim } from "@/domain/kill-claims/status";
import { AppError, conflict, forbidden, notFound, validationError } from "@/lib/errors";
import {
  createKillClaimSchema,
  fieldErrors,
  resolveKillClaimSchema,
} from "@/lib/validation/schemas";
import { enforceRateLimit } from "@/server/infra/rate-limit";
import { getGitHubClient } from "@/server/github";
import { isGitHubError, type PullRequestInfo } from "@/server/github/types";
import { activityRepository } from "@/server/repositories/interaction-repository";
import {
  killClaimRepository,
  type KillClaimItem,
} from "@/server/repositories/kill-claim-repository";
import { mutantRepository } from "@/server/repositories/mutant-repository";
import type { Project } from "@/generated/prisma/client";
import type { KillClaimApplies, KillClaimStatus, PullRequestState } from "@/generated/prisma/enums";
import { pullRequestService } from "./pull-request-service";
import { reviewService } from "./review-service";

interface Checks {
  prState: PullRequestState | null;
  prTouchesTests: boolean | null;
  verifyCommitSha: string | null;
  applies: KillClaimApplies;
  appliesLine: number | null;
}

/**
 * "PR #123 adds a test that kills this mutant." Claims are structured,
 * checked against GitHub (PR state, merge commit, whether the original code
 * still exists there) and verified by reproductions or a reviewer verdict.
 * A claim never changes a mutant's outcome by itself.
 */
export const killClaimService = {
  listForMutant(mutantId: number) {
    return killClaimRepository.listForMutant(mutantId);
  },

  async getForMutant(claimId: string, mutantId: number) {
    const claim = await killClaimRepository.findById(claimId);
    if (!claim || claim.mutantId !== mutantId)
      throw validationError("Unknown claim", { killClaimId: "Unknown claim" });
    return claim;
  },

  async create(principal: Principal | null, rawInput: unknown): Promise<KillClaimItem> {
    if (!principal) throw forbidden("Sign in to report a killing test");
    const parsed = createKillClaimSchema.safeParse(rawInput);
    if (!parsed.success)
      throw validationError("Please fix the highlighted fields", fieldErrors(parsed.error));
    const input = parsed.data;
    const ref = parseKillReference(input.reference);
    if (!ref)
      throw validationError("Enter a pull request (#123 or URL), a commit SHA or a test path", {
        reference: "Not recognised",
      });

    const mutant = await mutantRepository.findDetail(input.mutantId);
    if (!mutant) throw notFound("Mutant");
    const project = mutant.project;
    if (ref.repository) {
      const same =
        ref.repository.owner.toLowerCase() === project.githubOwner.toLowerCase() &&
        ref.repository.repo.toLowerCase() === project.githubRepository.toLowerCase();
      if (!same)
        throw validationError("That link points at another repository", {
          reference: "Wrong repository",
        });
    }
    await enforceRateLimit({
      action: "kill-claim",
      subject: principal.id,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });

    const kind = ref.reference.kind;
    const reference =
      ref.reference.kind === "PULL_REQUEST"
        ? String(ref.reference.number)
        : ref.reference.kind === "COMMIT"
          ? ref.reference.sha
          : ref.reference.path;
    if (await killClaimRepository.findDuplicate(mutant.id, kind, reference))
      throw conflict(`${referenceLabel(kind, reference)} is already claimed for this mutant`);

    const { checks, pullRequestId } = await runChecks(project, mutant, kind, reference);
    const status = evaluateClaim({ results: [], prState: checks.prState });
    const claim = await killClaimRepository.create({
      mutantId: mutant.id,
      claimedById: principal.id,
      kind,
      reference,
      note: input.note ?? null,
      pullRequestId,
      ...checks,
      status,
    });
    await activityRepository.recordEvent({
      type: "KILL_CLAIMED",
      actorId: principal.id,
      projectId: project.id,
      mutantId: mutant.id,
      payload: { claimId: claim.id, kind, reference },
      detail: referenceLabel(kind, reference),
    });
    if (pullRequestId)
      void pullRequestService.refreshCheckRun(pullRequestId).catch(() => undefined);
    return claim;
  },

  /** Re-runs the GitHub checks (PR state, merge commit, code still present). */
  async refresh(principal: Principal | null, claimId: string): Promise<KillClaimItem> {
    if (!principal) throw forbidden("Sign in to continue");
    const claim = await killClaimRepository.findById(claimId);
    if (!claim) throw notFound("Claim");
    await enforceRateLimit({
      action: "kill-claim-refresh",
      subject: principal.id,
      limit: 60,
      windowMs: 60 * 60 * 1000,
    });
    const { checks } = await runChecks(
      claim.mutant.project,
      claim.mutant,
      claim.kind,
      claim.reference,
    );
    const status =
      claim.status === "CLAIMED" || claim.status === "STALE"
        ? evaluateClaim({
            results: claim.validations.map((v) => v.result),
            prState: checks.prState,
          })
        : claim.status;
    return killClaimRepository.updateChecks(claim.id, { ...checks, status });
  },

  /** Applies the community rule after a reproduction was attached to the claim. */
  async reevaluate(claimId: string): Promise<void> {
    const claim = await killClaimRepository.findById(claimId);
    if (!claim || claim.resolvedById) return; // explicit verdicts are not overridden
    const status = evaluateClaim({
      results: claim.validations.map((v) => v.result),
      prState: claim.prState,
    });
    if (status === claim.status) return;
    await killClaimRepository.updateChecks(claim.id, { status });
    if (status === "VERIFIED" || status === "REFUTED") {
      await this.recordOutcome(claim, status, null, null);
    }
  },

  /** Reviewer verdict; VERIFIED also marks the mutant as killed. */
  async resolve(principal: Principal | null, rawInput: unknown): Promise<KillClaimItem> {
    if (!principal) throw forbidden("Sign in to continue");
    const parsed = resolveKillClaimSchema.safeParse(rawInput);
    if (!parsed.success) throw validationError("Invalid verdict", fieldErrors(parsed.error));
    const claim = await killClaimRepository.findById(parsed.data.claimId);
    if (!claim) throw notFound("Claim");
    if (!canReviewProject(principal, claim.mutant.projectId))
      throw forbidden("Only reviewers can verify claims");
    const updated = await killClaimRepository.resolve(claim.id, {
      status: parsed.data.verdict,
      resolvedById: principal.id,
      resolutionNote: parsed.data.note ?? null,
    });
    await this.recordOutcome(claim, parsed.data.verdict, principal, parsed.data.note ?? null);
    return updated;
  },

  async recordOutcome(
    claim: NonNullable<Awaited<ReturnType<typeof killClaimRepository.findById>>>,
    status: KillClaimStatus,
    principal: Principal | null,
    note: string | null,
  ): Promise<void> {
    const label = referenceLabel(claim.kind, claim.reference);
    await activityRepository.recordEvent({
      type: status === "VERIFIED" ? "KILL_VERIFIED" : "KILL_REFUTED",
      actorId: principal?.id ?? null,
      projectId: claim.mutant.projectId,
      mutantId: claim.mutantId,
      payload: { claimId: claim.id, status, note },
      detail: label,
    });
    if (status === "VERIFIED" && claim.mutant.mutationStatus !== "KILLED") {
      // The outcome changes through the normal review path so history and audit stay complete.
      const actor: Principal = principal ?? {
        id: claim.claimedById,
        globalRole: "ADMIN",
        memberships: [],
      };
      try {
        await reviewService.changeMutationStatus(
          principal ? principal : actor,
          {
            mutantId: claim.mutantId,
            status: "KILLED",
            comment: `Killed by ${label}${note ? `: ${note}` : ""}`,
          },
          { system: !principal },
        );
      } catch (error) {
        console.error("[kill-claim] could not update mutant outcome", (error as Error).message);
      }
    }
    if (claim.pullRequestId)
      void pullRequestService.refreshCheckRun(claim.pullRequestId).catch(() => undefined);
  },
};

async function runChecks(
  project: Project,
  mutant: { filePath: string; startLine: number; originalCode: string },
  kind: KillClaimItem["kind"],
  reference: string,
): Promise<{ checks: Checks; pullRequestId: string | null }> {
  const client = getGitHubClient();
  const checks: Checks = {
    prState: null,
    prTouchesTests: null,
    verifyCommitSha: null,
    applies: "UNKNOWN",
    appliesLine: null,
  };
  let pullRequestId: string | null = null;

  if (kind === "PULL_REQUEST") {
    const number = Number(reference);
    let info: PullRequestInfo;
    try {
      // Sync the PR so it gets its own page and check run, without listing it
      // among the project's tracked pull requests.
      const pr = await pullRequestService.sync(project, number, { track: false });
      pullRequestId = pr.id;
      info = await client.getPullRequest(project.githubOwner, project.githubRepository, number);
    } catch (e) {
      if (e instanceof AppError && e.code === "VALIDATION")
        throw validationError(`Pull request #${number} was not found`, { reference: "Not found" });
      throw e;
    }
    checks.prState = info.state;
    try {
      const files = await client.getPullRequestFiles(
        project.githubOwner,
        project.githubRepository,
        number,
      );
      checks.prTouchesTests = files.some((f) => looksLikeTestPath(f.path));
    } catch {
      checks.prTouchesTests = null;
    }
    checks.verifyCommitSha = info.mergeCommitSha ?? info.headSha;
  } else if (kind === "COMMIT") {
    try {
      const commit = await client.getCommit(
        project.githubOwner,
        project.githubRepository,
        reference,
      );
      checks.verifyCommitSha = commit.sha;
    } catch (e) {
      if (isGitHubError(e) && e.kind === "NOT_FOUND")
        throw validationError("Commit not found in the repository", { reference: "Not found" });
      throw e;
    }
  }

  if (checks.verifyCommitSha) {
    try {
      const file = await client.getFile(
        project.githubOwner,
        project.githubRepository,
        checks.verifyCommitSha,
        mutant.filePath,
      );
      if (file.content != null) {
        const located = locateOriginalCode(file.content, mutant.originalCode, mutant.startLine);
        checks.applies = located.applies;
        checks.appliesLine = located.line;
      }
    } catch (e) {
      if (isGitHubError(e) && e.kind === "NOT_FOUND") checks.applies = "NOT_FOUND";
      else checks.applies = "UNKNOWN";
    }
  }
  return { checks, pullRequestId };
}
