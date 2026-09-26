import "server-only";
import type { Principal } from "@/domain/auth/permissions";
import {
  canEditMutantText,
  canReviewProject,
  canSubmitMutant,
  isMutantOwner,
} from "@/domain/auth/permissions";
import { computeFingerprint } from "@/domain/mutants/fingerprint";
import { generateTitle } from "@/domain/mutants/title";
import { generateUnifiedDiff, looksLikeUnifiedDiff } from "@/domain/mutants/diff";
import { formatRanges, spanWithinRanges } from "@/domain/pull-requests/diff-ranges";
import {
  canEditSubmission,
  canResubmit,
  canWithdraw,
  initialMutationStatus,
} from "@/domain/mutants/status";
import { summarizeValidations } from "@/domain/mutants/validation-summary";
import { AppError, forbidden, notFound, validationError } from "@/lib/errors";
import { enforceRateLimit, RATE_LIMITS } from "@/server/infra/rate-limit";
import {
  editDescriptionSchema,
  editMutantSchema,
  editTitleSchema,
  fieldErrors,
  mutantListFilterSchema,
  resubmitMutantSchema,
  submitMutantSchema,
  withdrawMutantSchema,
  type MutantListFilter,
} from "@/lib/validation/schemas";
import { isGitHubError } from "@/server/github/types";
import {
  mutantRepository,
  type MutantListItem,
  type MutantDetail,
} from "@/server/repositories/mutant-repository";
import { projectRepository } from "@/server/repositories/project-repository";
import { projectService } from "./project-service";
import { pullRequestService } from "./pull-request-service";

export interface DuplicateCheck {
  exact: MutantListItem[];
  similar: MutantListItem[];
}

export interface MutantDetailView {
  mutant: MutantDetail;
  validationSummary: ReturnType<typeof summarizeValidations>;
  /** True when the project's default branch has moved past the mutant's revision. */
  isOlderRevision: boolean;
  headSha: string | null;
  canReview: boolean;
  duplicateCheck: DuplicateCheck;
  /** Submitter lifecycle permissions for the current principal. */
  lifecycle: {
    canEdit: boolean;
    canEditText: boolean;
    canResubmit: boolean;
    canWithdraw: boolean;
  };
}

export const mutantService = {
  /**
   * Creates a mutant from a submission form. The diff is generated when the
   * contributor did not paste one. Duplicate detection never blocks: matching
   * mutants are returned so the UI can show a "possible duplicate" notice.
   */
  async submitMutant(principal: Principal | null, rawInput: unknown) {
    if (!principal || !canSubmitMutant(principal)) throw forbidden("Sign in to submit a mutant");
    const parsed = submitMutantSchema.safeParse(rawInput);
    if (!parsed.success)
      throw validationError("Please fix the highlighted fields", fieldErrors(parsed.error));
    const input = parsed.data;
    await enforceRateLimit({
      ...RATE_LIMITS.submitMutant,
      action: "submit-mutant",
      subject: principal.id,
    });

    const project = await projectRepository.findById(input.projectId);
    if (!project || !project.isActive) throw notFound("Project");

    let revision;
    try {
      revision = (await projectService.ensureRevision(project, input.commitSha)).revision;
    } catch (e) {
      if (isGitHubError(e) && e.kind === "NOT_FOUND")
        throw validationError("Commit not found", {
          commitSha: "Commit not found in the repository",
        });
      if (isGitHubError(e) && e.kind === "RATE_LIMITED")
        throw new AppError("UPSTREAM", "GitHub rate limit reached. Please try again later.");
      throw e;
    }

    const gitDiff = looksLikeUnifiedDiff(input.gitDiff)
      ? input.gitDiff
      : generateUnifiedDiff({
          filePath: input.filePath,
          startLine: input.startLine,
          originalCode: input.originalCode,
          mutatedCode: input.mutatedCode,
        });

    const fingerprint = computeFingerprint({
      projectId: project.id,
      revisionId: revision.id,
      filePath: input.filePath,
      startLine: input.startLine,
      originalCode: input.originalCode,
      mutatedCode: input.mutatedCode,
    });

    // Pull request mode: the mutant must sit on lines the pull request changed, at its head.
    let pullRequestId: string | null = null;
    if (input.pullRequestNumber) {
      const context = await pullRequestService.getFileContext(
        project,
        input.pullRequestNumber,
        input.filePath,
      );
      if (!context)
        throw validationError("Pull request not tracked", {
          endLine: `Pull request #${input.pullRequestNumber} is not tracked for this project`,
        });
      if (context.headSha.toLowerCase() !== revision.commitSha.toLowerCase())
        throw validationError("Wrong commit for the pull request", {
          commitSha: `Mutants for PR #${context.number} must target its head commit ${context.headSha.slice(0, 7)}`,
        });
      if (!spanWithinRanges(input.startLine, input.endLine, context.ranges))
        throw validationError("Only lines changed by the pull request can be mutated", {
          endLine: context.fileInDiff
            ? `Lines ${input.startLine}–${input.endLine} are outside the diff of PR #${context.number} (changed lines: ${formatRanges(context.ranges)})`
            : `${input.filePath} is not part of the diff of PR #${context.number}`,
        });
      pullRequestId = context.id;
    }

    const created = await mutantRepository.create({
      projectId: project.id,
      revisionId: revision.id,
      pullRequestId,
      filePath: input.filePath,
      startLine: input.startLine,
      endLine: input.endLine,
      originalCode: input.originalCode,
      mutatedCode: input.mutatedCode,
      gitDiff,
      mutationOperator: input.mutationOperator,
      title:
        input.title ??
        generateTitle({
          mutationOperator: input.mutationOperator,
          filePath: input.filePath,
          startLine: input.startLine,
        }),
      description: input.description ?? null,
      fingerprint,
      mutationStatus: initialMutationStatus(input.observedResult),
      createdById: principal.id,
      submission: {
        buildCommand: input.buildCommand ?? null,
        testCommand: input.testCommand,
        fuzzCommand: input.fuzzCommand ?? null,
        testDurationSeconds: input.testDurationSeconds ?? null,
        environmentDescription: input.environmentDescription ?? null,
        operatingSystem: input.operatingSystem ?? null,
        compiler: input.compiler ?? null,
        observedResult: input.observedResult,
        notes: input.notes ?? null,
        stdout: input.stdout ?? null,
        stderr: input.stderr ?? null,
      },
    });

    const duplicates = await this.findDuplicates({
      projectId: project.id,
      revisionId: revision.id,
      filePath: input.filePath,
      startLine: input.startLine,
      originalCode: input.originalCode,
      mutatedCode: input.mutatedCode,
      excludeMutantId: created.id,
    });
    void pullRequestService.refreshForMutant(created);

    return { mutant: created, duplicates };
  },

  /** Exact (same fingerprint) and similar (same code at other revisions or lines) mutants. */
  async findDuplicates(params: {
    projectId: string;
    revisionId: string;
    filePath: string;
    startLine: number;
    originalCode: string;
    mutatedCode: string;
    excludeMutantId?: number;
  }): Promise<DuplicateCheck> {
    const fingerprint = computeFingerprint(params);
    const [exactAll, similarAll] = await Promise.all([
      mutantRepository.findByFingerprint(fingerprint),
      mutantRepository.findSimilar({ ...params, excludeFingerprint: fingerprint }),
    ]);
    const exact = exactAll.filter((m) => m.id !== params.excludeMutantId);
    const similar = similarAll.filter((m) => m.id !== params.excludeMutantId);
    return { exact, similar };
  },

  /** Pre-submission duplicate preview for the drawer. Resolves the commit without persisting. */
  async previewDuplicates(params: {
    projectId: string;
    commitSha: string;
    filePath: string;
    startLine: number;
    originalCode: string;
    mutatedCode: string;
  }): Promise<DuplicateCheck> {
    const project = await projectRepository.findById(params.projectId);
    if (!project) throw notFound("Project");
    const revision = await projectRepository.findRevision(project.id, params.commitSha);
    if (!revision) {
      // No mutant exists for this commit yet, so only similar matches are possible.
      const similar = await mutantRepository.findSimilar({
        projectId: project.id,
        filePath: params.filePath,
        originalCode: params.originalCode,
        mutatedCode: params.mutatedCode,
      });
      return { exact: [], similar };
    }
    return this.findDuplicates({ ...params, revisionId: revision.id });
  },

  async getDetail(principal: Principal | null, id: number): Promise<MutantDetailView> {
    const mutant = await mutantRepository.findDetail(id);
    if (!mutant) throw notFound("Mutant");
    const [head, duplicateCheck] = await Promise.all([
      projectService.getHeadCommit(mutant.project),
      this.findDuplicates({
        projectId: mutant.projectId,
        revisionId: mutant.revisionId,
        filePath: mutant.filePath,
        startLine: mutant.startLine,
        originalCode: mutant.originalCode,
        mutatedCode: mutant.mutatedCode,
        excludeMutantId: mutant.id,
      }),
    ]);
    return {
      mutant,
      validationSummary: summarizeValidations(mutant.validations.map((v) => v.result)),
      isOlderRevision: head ? head.sha !== mutant.revision.commitSha : false,
      headSha: head?.sha ?? null,
      canReview: canReviewProject(principal, mutant.projectId),
      duplicateCheck,
      lifecycle: {
        canEdit: isMutantOwner(principal, mutant) && canEditSubmission(mutant.reviewStatus),
        canEditText: canEditMutantText(principal, mutant),
        canResubmit: isMutantOwner(principal, mutant) && canResubmit(mutant.reviewStatus),
        canWithdraw: isMutantOwner(principal, mutant) && canWithdraw(mutant.reviewStatus),
      },
    };
  },

  /**
   * Contributor edit. Allowed while the mutant is PENDING or NEEDS_INFORMATION.
   * The location is immutable; the fingerprint is recomputed because the code
   * pair may have changed. Previous evidence is kept as an older submission row.
   */
  async editMutant(principal: Principal | null, rawInput: unknown) {
    if (!principal) throw forbidden("Sign in to edit a submission");
    const parsed = editMutantSchema.safeParse(rawInput);
    if (!parsed.success)
      throw validationError("Please fix the highlighted fields", fieldErrors(parsed.error));
    const input = parsed.data;

    const mutant = await mutantRepository.findDetail(input.mutantId);
    if (!mutant) throw notFound("Mutant");
    if (!isMutantOwner(principal, mutant))
      throw forbidden("Only the submitter can edit this mutant");
    if (!canEditSubmission(mutant.reviewStatus))
      throw validationError(
        `A ${mutant.reviewStatus.toLowerCase().replace("_", " ")} mutant can no longer be edited`,
      );
    await enforceRateLimit({
      ...RATE_LIMITS.submitMutant,
      action: "edit-mutant",
      subject: principal.id,
    });

    const gitDiff = looksLikeUnifiedDiff(input.gitDiff)
      ? input.gitDiff
      : generateUnifiedDiff({
          filePath: mutant.filePath,
          startLine: mutant.startLine,
          originalCode: input.originalCode,
          mutatedCode: input.mutatedCode,
        });
    const fingerprint = computeFingerprint({
      projectId: mutant.projectId,
      revisionId: mutant.revisionId,
      filePath: mutant.filePath,
      startLine: mutant.startLine,
      originalCode: input.originalCode,
      mutatedCode: input.mutatedCode,
    });

    const fields = {
      title:
        input.title ??
        generateTitle({
          mutationOperator: input.mutationOperator,
          filePath: mutant.filePath,
          startLine: mutant.startLine,
        }),
      mutationOperator: input.mutationOperator,
      originalCode: input.originalCode,
      mutatedCode: input.mutatedCode,
      gitDiff,
      description: input.description ?? null,
      fingerprint,
    };
    const latest = mutant.submissions[mutant.submissions.length - 1];
    const submission = {
      buildCommand: input.buildCommand ?? null,
      testCommand: input.testCommand,
      fuzzCommand: input.fuzzCommand ?? null,
      testDurationSeconds: input.testDurationSeconds ?? null,
      environmentDescription: input.environmentDescription ?? null,
      operatingSystem: input.operatingSystem ?? null,
      compiler: input.compiler ?? null,
      observedResult: input.observedResult,
      notes: input.notes ?? null,
      stdout: input.stdout ?? null,
      stderr: input.stderr ?? null,
    };
    const changedFields = [
      ...(Object.keys(fields) as Array<keyof typeof fields>).filter(
        (k) => k !== "fingerprint" && fields[k] !== mutant[k],
      ),
      ...(Object.keys(submission) as Array<keyof typeof submission>).filter(
        (k) => !latest || submission[k] !== latest[k],
      ),
    ];

    const updated = await mutantRepository.updateSubmission({
      mutantId: mutant.id,
      projectId: mutant.projectId,
      editedById: principal.id,
      fields,
      submission,
      changedFields,
      editReason: input.editReason ?? null,
    });
    const duplicates = await this.findDuplicates({
      projectId: mutant.projectId,
      revisionId: mutant.revisionId,
      filePath: mutant.filePath,
      startLine: mutant.startLine,
      originalCode: input.originalCode,
      mutatedCode: input.mutatedCode,
      excludeMutantId: mutant.id,
    });
    return { mutant: updated, duplicates, changedFields };
  },

  /**
   * Owner updates only the description. Allowed at any review status, so an
   * approved mutant can still be documented better without re-entering review.
   */
  async editDescription(principal: Principal | null, rawInput: unknown) {
    if (!principal) throw forbidden("Sign in to edit a description");
    const parsed = editDescriptionSchema.safeParse(rawInput);
    if (!parsed.success)
      throw validationError("Please fix the highlighted fields", fieldErrors(parsed.error));
    const input = parsed.data;

    const mutant = await mutantRepository.findDetail(input.mutantId);
    if (!mutant) throw notFound("Mutant");
    if (!canEditMutantText(principal, mutant))
      throw forbidden("Only the submitter can edit this description");
    await enforceRateLimit({
      ...RATE_LIMITS.submitMutant,
      action: "edit-mutant",
      subject: principal.id,
    });

    const description = input.description ?? null;
    if (description === mutant.description) return { mutant, changed: false };
    const updated = await mutantRepository.updateText({
      mutantId: mutant.id,
      projectId: mutant.projectId,
      editedById: principal.id,
      fields: { description },
    });
    return { mutant: updated, changed: true };
  },

  /**
   * Owner updates only the title, at any review status. An empty title is
   * regenerated from the operator and location, as on submission.
   */
  async editTitle(principal: Principal | null, rawInput: unknown) {
    if (!principal) throw forbidden("Sign in to edit a title");
    const parsed = editTitleSchema.safeParse(rawInput);
    if (!parsed.success)
      throw validationError("Please fix the highlighted fields", fieldErrors(parsed.error));
    const input = parsed.data;

    const mutant = await mutantRepository.findDetail(input.mutantId);
    if (!mutant) throw notFound("Mutant");
    if (!canEditMutantText(principal, mutant))
      throw forbidden("Only the submitter can edit this title");
    await enforceRateLimit({
      ...RATE_LIMITS.submitMutant,
      action: "edit-mutant",
      subject: principal.id,
    });

    const title =
      input.title ??
      generateTitle({
        mutationOperator: mutant.mutationOperator,
        filePath: mutant.filePath,
        startLine: mutant.startLine,
      });
    if (title === mutant.title) return { mutant, changed: false };
    const updated = await mutantRepository.updateText({
      mutantId: mutant.id,
      projectId: mutant.projectId,
      editedById: principal.id,
      fields: { title },
    });
    return { mutant: updated, changed: true };
  },

  /** Submitter re-opens a NEEDS_INFORMATION or WITHDRAWN mutant for review. */
  async resubmitMutant(principal: Principal | null, rawInput: unknown) {
    if (!principal) throw forbidden("Sign in to continue");
    const parsed = resubmitMutantSchema.safeParse(rawInput);
    if (!parsed.success) throw validationError("Invalid request", fieldErrors(parsed.error));
    const mutant = await mutantRepository.findListItem(parsed.data.mutantId);
    if (!mutant) throw notFound("Mutant");
    if (!isMutantOwner(principal, { createdById: mutant.createdBy.id }))
      throw forbidden("Only the submitter can resubmit this mutant");
    if (!canResubmit(mutant.reviewStatus))
      throw validationError(
        "Only mutants that need information or were withdrawn can be resubmitted",
      );
    await enforceRateLimit({ ...RATE_LIMITS.review, action: "lifecycle", subject: principal.id });
    return mutantRepository.changeStatus({
      mutantId: mutant.id,
      kind: "REVIEW",
      previousValue: mutant.reviewStatus,
      newValue: "PENDING",
      changedById: principal.id,
      comment: parsed.data.comment ?? null,
      activityType: "MUTANT_RESUBMITTED",
      projectId: mutant.project.id,
    });
  },

  /** Submitter withdraws a PENDING or NEEDS_INFORMATION mutant. */
  async withdrawMutant(principal: Principal | null, rawInput: unknown) {
    if (!principal) throw forbidden("Sign in to continue");
    const parsed = withdrawMutantSchema.safeParse(rawInput);
    if (!parsed.success) throw validationError("Invalid request", fieldErrors(parsed.error));
    const mutant = await mutantRepository.findListItem(parsed.data.mutantId);
    if (!mutant) throw notFound("Mutant");
    if (!isMutantOwner(principal, { createdById: mutant.createdBy.id }))
      throw forbidden("Only the submitter can withdraw this mutant");
    if (!canWithdraw(mutant.reviewStatus))
      throw validationError("Only pending mutants can be withdrawn");
    await enforceRateLimit({ ...RATE_LIMITS.review, action: "lifecycle", subject: principal.id });
    return mutantRepository.changeStatus({
      mutantId: mutant.id,
      kind: "REVIEW",
      previousValue: mutant.reviewStatus,
      newValue: "WITHDRAWN",
      changedById: principal.id,
      comment: parsed.data.reason ?? null,
      activityType: "MUTANT_WITHDRAWN",
      projectId: mutant.project.id,
    });
  },

  async list(rawFilter: unknown) {
    const parsed = mutantListFilterSchema.safeParse(rawFilter);
    const filter: MutantListFilter = parsed.success
      ? parsed.data
      : mutantListFilterSchema.parse({});
    let projectId: string | undefined;
    if (filter.project) {
      const [owner, repo] = filter.project.split("/");
      const project = owner && repo ? await projectRepository.findBySlug(owner, repo) : null;
      if (!project) return { items: [], total: 0, filter };
      projectId = project.id;
    }
    const result = await mutantRepository.list(
      {
        projectId,
        language: filter.language,
        mutationOperator: filter.operator,
        reviewStatus: filter.reviewStatus,
        mutationStatus: filter.mutationStatus,
        createdByUsername: filter.contributor,
        commitShaPrefix: filter.commit,
        filePathContains: filter.file,
        text: filter.q,
        importBatchId: filter.batch,
        driftStatus: filter.drift,
      },
      { page: filter.page, pageSize: filter.pageSize },
    );
    return { ...result, filter };
  },

  /** Mutants for a file at a revision plus how many exist at other revisions. */
  async listForFile(projectId: string, revisionId: string, filePath: string) {
    const [mutants, otherRevisions] = await Promise.all([
      mutantRepository.listForFile(projectId, revisionId, filePath),
      mutantRepository.countForFileOtherRevisions(projectId, revisionId, filePath),
    ]);
    return { mutants, otherRevisions };
  },
};

export function validationSummaryFor(item: MutantListItem) {
  return summarizeValidations(item.validations.map((v) => v.result));
}
