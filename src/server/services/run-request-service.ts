import "server-only";
import type { Principal } from "@/domain/auth/permissions";
import { canManageRunRequest } from "@/domain/auth/permissions";
import { parseChangedRanges } from "@/domain/pull-requests/diff-ranges";
import {
  reportSummary,
  runRequestNotificationTitle,
  runRequestRecipients,
  type RunRequestEventType,
} from "@/domain/run-requests/notifications";
import {
  CLAIM_TTL_MS,
  checkRunCounts,
  DISPLAY_STATUS_RANK,
  displayStatus,
  isLiveClaim,
  type RunRequestDisplayStatus,
} from "@/domain/run-requests/status";
import { conflict, forbidden, notFound, validationError } from "@/lib/errors";
import {
  closeRunRequestSchema,
  createRunRequestSchema,
  fieldErrors,
  reportRunSchema,
  runRequestIdSchema,
} from "@/lib/validation/schemas";
import { enforceRateLimit } from "@/server/infra/rate-limit";
import { projectRepository } from "@/server/repositories/project-repository";
import {
  runRequestRepository,
  type RunRequestDetail,
  type RunRequestListItem,
} from "@/server/repositories/run-request-repository";
import type { Project } from "@/generated/prisma/client";
import { pullRequestService } from "./pull-request-service";

/** The signed-in user; the username is used in notification titles. */
export type RunRequestActor = Principal & { githubUsername: string };

/** Open requests one user may have at a time, to keep the board meaningful. */
const MAX_OPEN_PER_USER = 10;

function withStatus<T extends RunRequestListItem | RunRequestDetail>(request: T, now: Date) {
  return {
    ...request,
    displayStatus: displayStatus(
      {
        status: request.status,
        headSha: request.headSha,
        prHeadSha: request.pullRequest.headSha,
        claims: request.claims,
      },
      now,
    ),
    liveClaims: request.claims.filter((c) => isLiveClaim(c, now)).length,
    reports: request.claims.filter((c) => c.status === "REPORTED").length,
  };
}

export type RunRequestRow = ReturnType<typeof withStatus<RunRequestListItem>>;

function readId(rawInput: unknown): string {
  const parsed = runRequestIdSchema.safeParse(rawInput);
  if (!parsed.success) throw notFound("Run request");
  return parsed.data.requestId;
}

/**
 * "Could someone run mutation testing on PR #123?" A contributor opens a
 * request against the PR's current head; runners claim it ("I'm running
 * this"), report what they ran, and submit surviving mutants as usual.
 * Reports are self-reported evidence and never change a mutant's outcome.
 */
export const runRequestService = {
  async listForProject(project: Project, filter: "open" | "closed" | "all" = "open") {
    const now = new Date();
    const rows = await runRequestRepository.listForProject(project.id, {
      open: filter === "all" ? undefined : filter === "open",
    });
    return rows
      .map((r) => withStatus(r, now))
      .sort(
        (a, b) =>
          DISPLAY_STATUS_RANK[a.displayStatus] - DISPLAY_STATUS_RANK[b.displayStatus] ||
          b._count.votes - a._count.votes ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      );
  },

  countOpen(project: Project) {
    return runRequestRepository.countOpenForProject(project.id);
  },

  async listForPullRequest(pullRequestId: string) {
    const now = new Date();
    const rows = await runRequestRepository.listForPullRequest(pullRequestId);
    return rows.map((r) => withStatus(r, now));
  },

  /** The request, its derived status and the PR's mutants on the requested files. */
  async getDetail(project: Project, id: string) {
    const request = await runRequestRepository.findById(id);
    if (!request || request.projectId !== project.id) throw notFound("Run request");
    const pr = await pullRequestService.getDetail(project, request.pullRequest.number);
    const scope = new Set(request.files);
    const files = scope.size ? pr.files.filter((f) => scope.has(f.path)) : pr.files;
    const coverage = {
      files,
      changedLines: files.reduce((n, f) => n + f.changedLines, 0),
      untouched: files.filter((f) => f.mutants === 0).length,
    };
    return { request: withStatus(request, new Date()), stats: pr.stats, coverage };
  },

  async create(actor: RunRequestActor | null, rawInput: unknown) {
    if (!actor) throw forbidden("Sign in to request a mutation testing run");
    const parsed = createRunRequestSchema.safeParse(rawInput);
    if (!parsed.success)
      throw validationError("Please fix the highlighted fields", fieldErrors(parsed.error));
    const input = parsed.data;
    const project = await projectRepository.findById(input.projectId);
    if (!project || !project.isActive) throw notFound("Project");
    await enforceRateLimit({
      action: "run-request",
      subject: actor.id,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if ((await runRequestRepository.countOpenByUser(actor.id)) >= MAX_OPEN_PER_USER)
      throw conflict(
        `You already have ${MAX_OPEN_PER_USER} open requests. Close one before opening another.`,
      );

    // Always re-sync: the request pins the head commit as it is right now.
    const pr = await pullRequestService.sync(project, input.number);
    if (pr.state !== "OPEN")
      throw validationError(`Pull request #${pr.number} is ${pr.state.toLowerCase()}`, {
        number: "Only open pull requests can be requested",
      });
    if (await runRequestRepository.findOpenForPullRequest(pr.id))
      throw conflict(
        `There is already an open request for #${pr.number}. Add your +1 to it instead.`,
      );
    const changed = parseChangedRanges(pr.changedRanges);
    const files = [...new Set(input.files)];
    const unknown = files.filter((f) => !(f in changed));
    if (unknown.length)
      throw validationError("Some files are not changed by this pull request", {
        files: `Not in the diff: ${unknown.slice(0, 3).join(", ")}`,
      });

    const request = await runRequestRepository.create({
      projectId: project.id,
      pullRequestId: pr.id,
      requestedById: actor.id,
      headSha: pr.headSha,
      files,
      notes: input.notes ?? null,
    });
    if (!request)
      throw conflict(
        `There is already an open request for #${pr.number}. Add your +1 to it instead.`,
      );
    await this.notify("RUN_REQUESTED", actor, request.id, project, pr.number);
    return { id: request.id, number: pr.number };
  },

  async setVote(actor: RunRequestActor | null, rawInput: unknown, on: boolean) {
    if (!actor) throw forbidden("Sign in to support a request");
    const request = await this.requireOpen(readId(rawInput));
    await runRequestRepository.setVote(request.id, actor.id, on);
    return request;
  },

  /** "I'm running this": a claim that expires after CLAIM_TTL_MS; claiming again extends it. */
  async claim(actor: RunRequestActor | null, rawInput: unknown) {
    if (!actor) throw forbidden("Sign in to claim a request");
    const request = await this.requireOpen(readId(rawInput));
    await enforceRateLimit({
      action: "run-claim",
      subject: actor.id,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    const expiresAt = new Date(Date.now() + CLAIM_TTL_MS);
    const existing = await runRequestRepository.findActiveClaim(request.id, actor.id);
    if (existing) {
      await runRequestRepository.extendClaim(existing.id, expiresAt);
      return request;
    }
    await runRequestRepository.createClaim({ requestId: request.id, userId: actor.id, expiresAt });
    await this.notify(
      "RUN_CLAIMED",
      actor,
      request.id,
      request.project,
      request.pullRequest.number,
    );
    return request;
  },

  async abandon(actor: RunRequestActor | null, rawInput: unknown) {
    if (!actor) throw forbidden("Sign in to continue");
    const request = await runRequestRepository.findById(readId(rawInput));
    if (!request) throw notFound("Run request");
    const claim = await runRequestRepository.findActiveClaim(request.id, actor.id);
    if (!claim) throw conflict("You have no active claim on this request");
    await runRequestRepository.abandonClaim(claim.id);
    return request;
  },

  /**
   * Records what the runner ran and what came out, including "nothing
   * survived". Allowed on closed requests too (a run may finish after the PR
   * merges), but not on cancelled ones.
   */
  async report(actor: RunRequestActor | null, rawInput: unknown) {
    if (!actor) throw forbidden("Sign in to report a run");
    const parsed = reportRunSchema.safeParse(rawInput);
    if (!parsed.success)
      throw validationError("Please fix the highlighted fields", fieldErrors(parsed.error));
    const input = parsed.data;
    const counts = checkRunCounts(input);
    if (counts) throw validationError(counts.message, { [counts.field]: counts.message });
    const request = await runRequestRepository.findById(input.requestId);
    if (!request) throw notFound("Run request");
    if (request.status === "CANCELLED") throw conflict("This request was cancelled");
    await enforceRateLimit({
      action: "run-report",
      subject: actor.id,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    const claim = await runRequestRepository.findActiveClaim(request.id, actor.id);
    await runRequestRepository.report(request.id, actor.id, claim?.id ?? null, {
      commitSha: input.commitSha,
      toolName: input.toolName,
      toolVersion: input.toolVersion ?? null,
      command: input.command ?? null,
      generated: input.generated,
      killed: input.killed,
      survived: input.survived,
      durationSeconds: input.durationSeconds ?? null,
      environment: input.environment ?? null,
      notes: input.notes ?? null,
    });
    await this.notify(
      "RUN_REPORTED",
      actor,
      request.id,
      request.project,
      request.pullRequest.number,
      reportSummary(input),
    );
    return request;
  },

  /** Requester or reviewer: CLOSED when fulfilled, CANCELLED when no longer wanted. */
  async close(actor: RunRequestActor | null, rawInput: unknown) {
    if (!actor) throw forbidden("Sign in to continue");
    const parsed = closeRunRequestSchema.safeParse(rawInput);
    if (!parsed.success) throw validationError("Invalid request", fieldErrors(parsed.error));
    const request = await this.requireOpen(parsed.data.requestId);
    if (!canManageRunRequest(actor, request))
      throw forbidden("Only the requester or a reviewer can close this request");
    await runRequestRepository.close(request.id, {
      status: parsed.data.outcome,
      closedById: actor.id,
      reason: parsed.data.reason ?? null,
    });
    return request;
  },

  /** Points an outdated request at the PR's current head. */
  async retarget(actor: RunRequestActor | null, rawInput: unknown) {
    if (!actor) throw forbidden("Sign in to continue");
    const request = await this.requireOpen(readId(rawInput));
    if (!canManageRunRequest(actor, request))
      throw forbidden("Only the requester or a reviewer can retarget this request");
    const pr = await pullRequestService.sync(request.project, request.pullRequest.number);
    if (pr.state !== "OPEN") throw conflict(`Pull request #${pr.number} is no longer open`);
    await runRequestRepository.retarget(request.id, pr.headSha);
    return request;
  },

  async requireOpen(id: string) {
    const request = await runRequestRepository.findById(id);
    if (!request) throw notFound("Run request");
    if (request.status !== "OPEN") throw conflict("This request is no longer open");
    return request;
  },

  async notify(
    type: RunRequestEventType,
    actor: RunRequestActor,
    requestId: string,
    project: Project,
    prNumber: number,
    detail: string | null = null,
  ) {
    const participants = await runRequestRepository.participants(requestId);
    if (!participants) return;
    const event = {
      type,
      actorId: actor.id,
      actorUsername: actor.githubUsername,
      prNumber,
      projectName: project.displayName,
      detail,
    };
    const title = runRequestNotificationTitle(event);
    await runRequestRepository.recordEvent({
      type,
      actorId: actor.id,
      projectId: project.id,
      requestId,
      payload: { number: prNumber, ...(detail ? { detail } : {}) },
      notifications: runRequestRecipients(event, participants).map((userId) => ({
        userId,
        title,
        body: null,
      })),
    });
  },
};

export type { RunRequestDisplayStatus };
