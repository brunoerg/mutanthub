import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Code2,
  ExternalLink,
  GitPullRequest,
  Hand,
  RefreshCw,
  ThumbsUp,
  Undo2,
} from "lucide-react";
import { getCurrentUser } from "@/server/auth/session";
import { projectService } from "@/server/services/project-service";
import { runRequestService } from "@/server/services/run-request-service";
import { canManageRunRequest } from "@/domain/auth/permissions";
import { isLiveClaim, mutationScore, sameCommit } from "@/domain/run-requests/status";
import { isAppError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import { absoluteDateTime, formatDuration, relativeTime, shortSha } from "@/lib/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Section } from "@/components/shared/section";
import { Stat } from "@/components/shared/stat";
import { Markdown } from "@/components/shared/markdown";
import { UserChip } from "@/components/shared/user-chip";
import { PullRequestStateBadge } from "@/components/pull-requests/state-badge";
import { RunRequestStatusBadge } from "@/components/run-requests/status-badge";
import { RunRequestStepButton } from "@/components/run-requests/step-button";
import { ReportRunForm } from "@/components/run-requests/report-run-form";
import { CloseRunRequestForm } from "@/components/run-requests/close-run-request-form";

export const dynamic = "force-dynamic";

type Params = Promise<{ owner: string; repo: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { owner, repo } = await params;
  return { title: `Run request · ${owner}/${repo}` };
}

export default async function RunRequestPage({ params }: { params: Params }) {
  const { owner, repo, id } = await params;
  const user = await getCurrentUser();
  let project;
  let detail;
  try {
    project = await projectService.getBySlugOrThrow(owner, repo);
    detail = await runRequestService.getDetail(project, id);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const { request, stats, coverage } = detail;
  const pr = request.pullRequest;
  const now = new Date();
  const open = request.status === "OPEN";
  const canManage = canManageRunRequest(user, request);
  const voted = !!user && request.votes.some((v) => v.userId === user.id);
  const myClaim = user
    ? request.claims.find((c) => c.userId === user.id && isLiveClaim(c, now))
    : undefined;
  const running = request.claims.filter((c) => isLiveClaim(c, now));
  const reports = request.claims.filter((c) => c.status === "REPORTED");

  return (
    <PageContainer className="space-y-4" wide>
      <div data-testid="run-request-page">
        <PageHeader
          eyebrow={
            <span className="inline-flex flex-wrap items-center gap-2">
              <Link
                href={routes.projectRunRequests(owner, repo)}
                className="font-mono hover:underline"
              >
                {project.githubOwner}/{project.githubRepository} · run requests
              </Link>
              <RunRequestStatusBadge status={request.displayStatus} />
            </span>
          }
          title={
            <>
              Mutation testing for{" "}
              <span className="text-muted-foreground font-mono">#{pr.number}</span> {pr.title}
            </>
          }
          description={
            <span className="inline-flex flex-wrap items-center gap-1">
              Requested by <UserChip user={request.requestedBy} size="xs" />
              <span title={absoluteDateTime(request.createdAt)}>
                {relativeTime(request.createdAt)}
              </span>
              · at <span className="font-mono">{shortSha(request.headSha)}</span> ·{" "}
              <PullRequestStateBadge state={pr.state} />
            </span>
          }
          actions={
            <>
              <Button asChild variant="outline" size="sm">
                <Link href={routes.projectPull(owner, repo, pr.number)}>
                  <GitPullRequest className="size-3.5" aria-hidden /> Pull request mutants
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={pr.htmlUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-3.5" aria-hidden /> View on GitHub
                </a>
              </Button>
            </>
          }
        />
      </div>

      {request.displayStatus === "OUTDATED" ? (
        <Alert data-testid="run-request-outdated">
          <AlertTitle>The pull request has moved on</AlertTitle>
          <AlertDescription>
            <p>
              This request targets <span className="font-mono">{shortSha(request.headSha)}</span>;
              the pull request head is now <span className="font-mono">{shortSha(pr.headSha)}</span>
              . Runs against either commit are useful, but say which one you used.
            </p>
            {open && canManage ? (
              <div className="mt-2">
                <RunRequestStepButton
                  requestId={request.id}
                  step="retarget"
                  success="Request now targets the current head"
                  icon={<RefreshCw className="size-3.5" aria-hidden />}
                >
                  Retarget to {shortSha(pr.headSha)}
                </RunRequestStepButton>
              </div>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {!open ? (
        <Alert data-testid="run-request-closed">
          <AlertTitle>
            {request.status === "CANCELLED"
              ? "This request was cancelled"
              : "This request is closed"}
          </AlertTitle>
          <AlertDescription>
            {request.closedBy ? (
              <span className="inline-flex items-center gap-1">
                By <UserChip user={request.closedBy} size="xs" />
              </span>
            ) : null}{" "}
            {request.closedAt ? relativeTime(request.closedAt) : null}
            {request.closeReason ? ` · ${request.closeReason}` : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Runs reported" value={reports.length} testId="run-request-reports-count" />
        <Stat
          label="Running now"
          value={running.length}
          tone={running.length ? "info" : "default"}
        />
        <Stat
          label="Surviving on diff"
          value={stats.surviving}
          tone={stats.surviving ? "warning" : "default"}
          href={`${routes.projectPull(owner, repo, pr.number)}?mutationStatus=SURVIVED`}
        />
        <Stat
          label="Files without mutants"
          value={coverage.untouched}
          hint={`of ${coverage.files.length} in scope`}
          tone={coverage.untouched ? "warning" : "success"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {request.notes ? (
            <Section title="Notes from the requester">
              <Markdown source={request.notes} />
            </Section>
          ) : null}

          <Section
            title="Reported runs"
            description="Self-reported by the runners. Surviving mutants are submitted and reviewed separately."
          >
            {reports.length === 0 ? (
              <p className="text-muted-foreground text-xs">No runs reported yet.</p>
            ) : (
              <ul className="divide-border divide-y" data-testid="run-reports">
                {reports.map((c) => {
                  const score = mutationScore({ killed: c.killed ?? 0, survived: c.survived ?? 0 });
                  return (
                    <li
                      key={c.id}
                      className="space-y-1.5 py-3 first:pt-0 last:pb-0"
                      data-testid="run-report"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <UserChip user={c.user} size="xs" />
                        <span className="font-medium">
                          {c.toolName}
                          {c.toolVersion ? ` ${c.toolVersion}` : ""}
                        </span>
                        <span className="text-muted-foreground">
                          at <span className="font-mono">{shortSha(c.commitSha ?? "")}</span>
                          {!sameCommit(c.commitSha, request.headSha)
                            ? " (not the requested commit)"
                            : ""}
                          {c.reportedAt ? ` · ${relativeTime(c.reportedAt)}` : ""}
                          {formatDuration(c.durationSeconds)
                            ? ` · ${formatDuration(c.durationSeconds)}`
                            : ""}
                        </span>
                      </div>
                      <p className="text-sm" data-testid="run-report-counts">
                        {c.generated} generated · {c.killed} killed ·{" "}
                        <span
                          className={
                            c.survived ? "font-medium text-amber-700 dark:text-amber-300" : ""
                          }
                        >
                          {c.survived} survived
                        </span>
                        {score !== null ? (
                          <span className="text-muted-foreground">
                            {" "}
                            · score {Math.round(score * 100)}%
                          </span>
                        ) : null}
                      </p>
                      {c.command ? (
                        <pre className="bg-muted overflow-x-auto rounded p-2 font-mono text-[11px]">
                          {c.command}
                        </pre>
                      ) : null}
                      {c.environment ? (
                        <p className="text-muted-foreground text-xs">
                          Environment: {c.environment}
                        </p>
                      ) : null}
                      {c.notes ? <p className="text-xs whitespace-pre-wrap">{c.notes}</p> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section
            title={request.files.length ? "Files in scope" : "Changed files"}
            description={`${coverage.changedLines} changed lines · open in pull request mode to submit a mutant`}
          >
            <ul className="space-y-1.5 text-xs" data-testid="run-request-files">
              {coverage.files.map((f) => (
                <li key={f.path} className="flex items-center justify-between gap-2">
                  <Link
                    href={routes.projectCode(owner, repo, f.path, {
                      ref: pr.headSha,
                      pr: pr.number,
                      line: f.ranges[0]?.[0],
                    })}
                    className="min-w-0 truncate font-mono hover:underline"
                    title={f.path}
                  >
                    <Code2 className="mr-1 inline size-3 align-text-bottom" aria-hidden />
                    {f.path}
                  </Link>
                  <span
                    className={
                      f.mutants
                        ? "text-muted-foreground shrink-0"
                        : "shrink-0 text-amber-700 dark:text-amber-300"
                    }
                  >
                    {f.changedLines} lines · {f.mutants} mutant{f.mutants === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </div>

        <aside className="space-y-4">
          <Section title="Runners">
            {running.length === 0 ? (
              <p className="text-muted-foreground text-xs">Nobody has claimed this request.</p>
            ) : (
              <ul className="space-y-1.5 text-xs" data-testid="run-claims">
                {running.map((c) => (
                  <li key={c.id} className="flex items-center gap-1.5">
                    <UserChip user={c.user} size="xs" /> is running this · until{" "}
                    <span title={absoluteDateTime(c.expiresAt)}>{relativeTime(c.expiresAt)}</span>
                  </li>
                ))}
              </ul>
            )}
            {user && open ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <RunRequestStepButton
                  requestId={request.id}
                  step="claim"
                  success={myClaim ? "Claim extended" : "Claimed: you're on it"}
                  variant={myClaim ? "outline" : "default"}
                  icon={<Hand className="size-3.5" aria-hidden />}
                >
                  {myClaim ? "Extend my claim" : "I'm running this"}
                </RunRequestStepButton>
                {myClaim ? (
                  <RunRequestStepButton
                    requestId={request.id}
                    step="abandon"
                    success="Claim released"
                    variant="ghost"
                    icon={<Undo2 className="size-3.5" aria-hidden />}
                  >
                    Release
                  </RunRequestStepButton>
                ) : null}
                <RunRequestStepButton
                  requestId={request.id}
                  step={voted ? "unvote" : "vote"}
                  success={voted ? "Vote removed" : "Thanks, you'll be notified about runs"}
                  variant="ghost"
                  icon={<ThumbsUp className="size-3.5" aria-hidden />}
                >
                  {voted ? "Voted" : "+1"} · {request.votes.length}
                </RunRequestStepButton>
              </div>
            ) : !user ? (
              <p className="text-muted-foreground mt-2 text-xs">
                <Link
                  href={routes.signIn(routes.projectRunRequest(owner, repo, request.id))}
                  className="underline"
                >
                  Sign in
                </Link>{" "}
                to claim this request or report a run.
              </p>
            ) : null}
          </Section>

          {user && request.status !== "CANCELLED" ? (
            <Section title="Report a run">
              <ReportRunForm requestId={request.id} headSha={request.headSha} />
            </Section>
          ) : null}

          {open && canManage ? (
            <Section title="Close this request">
              <CloseRunRequestForm requestId={request.id} />
            </Section>
          ) : null}
        </aside>
      </div>
    </PageContainer>
  );
}
