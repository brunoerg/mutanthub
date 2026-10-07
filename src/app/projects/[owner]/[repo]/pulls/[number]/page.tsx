import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Code2, ExternalLink, RefreshCw } from "lucide-react";
import { getCurrentUser } from "@/server/auth/session";
import { projectService } from "@/server/services/project-service";
import { pullRequestService } from "@/server/services/pull-request-service";
import { runRequestService } from "@/server/services/run-request-service";
import { syncPullRequestAction } from "@/server/actions/pull-request-actions";
import { isAppError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import { absoluteDateTime, relativeTime, shortSha } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Section } from "@/components/shared/section";
import { Stat } from "@/components/shared/stat";
import { EmptyState } from "@/components/shared/empty-state";
import { MutantTable } from "@/components/mutants/mutant-table";
import { buildQuery } from "@/components/mutants/mutant-filters";
import { PullRequestMutantFilters } from "@/components/pull-requests/pr-mutant-filters";
import { PullRequestStateBadge } from "@/components/pull-requests/state-badge";
import { CreateRunRequestForm } from "@/components/run-requests/create-run-request-form";
import { RunRequestStatusBadge } from "@/components/run-requests/status-badge";
import { Bug } from "lucide-react";

export const dynamic = "force-dynamic";

type Params = Promise<{ owner: string; repo: string; number: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstValues(sp: Awaited<SearchParams>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (value) out[k] = value;
  }
  return out;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { owner, repo, number } = await params;
  return { title: `PR #${number} · ${owner}/${repo}` };
}

export default async function PullRequestPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { owner, repo, number: rawNumber } = await params;
  const rawFilter = firstValues(await searchParams);
  const number = Number(rawNumber);
  if (!Number.isInteger(number) || number <= 0) notFound();
  const user = await getCurrentUser();

  let project;
  let detail;
  try {
    project = await projectService.getBySlugOrThrow(owner, repo);
    detail = await pullRequestService.getDetail(project, number, rawFilter);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const { pr, onDiff, offDiff, files, filter, stats, totals, filePaths } = detail;
  const runRequests = await runRequestService.listForPullRequest(pr.id);
  const openRequest = runRequests.find((r) => r.status === "OPEN");
  const base = routes.projectPull(owner, repo, pr.number);
  const filtered = Object.values(filter).some(Boolean);
  const hrefWith = (over: Record<string, string | undefined>) =>
    `${base}${buildQuery({ ...filter, ...over })}`;
  const onlyStatus = (status: "SURVIVED" | "KILLED") =>
    filter.mutationStatus === status && !filter.reviewStatus && !filter.superseded;

  return (
    <PageContainer className="space-y-4" wide>
      <div data-testid="pull-request-page">
        <PageHeader
          eyebrow={
            <span className="inline-flex flex-wrap items-center gap-2">
              <Link href={routes.projectPulls(owner, repo)} className="font-mono hover:underline">
                {project.githubOwner}/{project.githubRepository} · pull requests
              </Link>
              <PullRequestStateBadge state={pr.state} />
            </span>
          }
          title={
            <>
              <span className="text-muted-foreground font-mono">#{pr.number}</span> {pr.title}
            </>
          }
          description={
            <>
              {pr.authorLogin ? (
                <>
                  by <span className="font-mono">@{pr.authorLogin}</span> ·{" "}
                </>
              ) : null}
              <span className="font-mono">{pr.headRef}</span> into{" "}
              <span className="font-mono">{pr.baseRef}</span> · head{" "}
              <span className="font-mono">{shortSha(pr.headSha)}</span> · synced{" "}
              <span title={absoluteDateTime(pr.lastSyncedAt)}>{relativeTime(pr.lastSyncedAt)}</span>
            </>
          }
          actions={
            <>
              {user ? (
                <form action={syncPullRequestAction}>
                  <input type="hidden" name="owner" value={owner} />
                  <input type="hidden" name="repo" value={repo} />
                  <input type="hidden" name="number" value={pr.number} />
                  <Button type="submit" variant="outline" size="sm" data-testid="sync-pull-request">
                    <RefreshCw className="size-3.5" aria-hidden /> Sync from GitHub
                  </Button>
                </form>
              ) : null}
              <Button asChild variant="outline" size="sm">
                <a href={pr.htmlUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-3.5" aria-hidden /> View on GitHub
                </a>
              </Button>
            </>
          }
        />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat
          label="Mutants on diff"
          value={stats.onDiff}
          hint={stats.superseded ? `${stats.superseded} superseded not counted` : undefined}
          href={base}
          active={!filtered}
          testId="pr-stat-on-diff"
        />
        <Stat
          label="Surviving"
          value={stats.surviving}
          tone={stats.surviving ? "warning" : "default"}
          href={hrefWith({
            mutationStatus: "SURVIVED",
            reviewStatus: undefined,
            superseded: undefined,
          })}
          active={onlyStatus("SURVIVED")}
          testId="pr-stat-surviving"
        />
        <Stat
          label="Killed"
          value={stats.killed}
          tone={stats.killed ? "success" : "default"}
          href={hrefWith({
            mutationStatus: "KILLED",
            reviewStatus: undefined,
            superseded: undefined,
          })}
          active={onlyStatus("KILLED")}
          testId="pr-stat-killed"
        />
        <Stat
          label="Pending review"
          value={stats.pending}
          tone={stats.pending ? "info" : "default"}
        />
        <Stat
          label="Changed files"
          value={pr.changedFiles}
          hint={`+${pr.additions} / -${pr.deletions}`}
        />
      </div>

      <p className="text-muted-foreground text-xs">
        A surviving mutant means the recorded tests did not detect it. It may be equivalent,
        environment-dependent, or not reproduced yet. The MutantHub check on GitHub carries the same
        summary and never blocks a merge.
      </p>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <PullRequestMutantFilters action={base} values={filter} filePaths={filePaths} />
          <Section
            title="Mutants on changed lines"
            description={`${onDiff.length} of ${totals.onDiff} recorded against this pull request`}
          >
            <div data-testid="pr-mutants-on-diff">
              <MutantTable
                mutants={onDiff}
                showProject={false}
                emptyTitle={
                  totals.onDiff
                    ? "No mutants match the filters"
                    : "No mutants on the changed lines yet"
                }
                emptyDescription={
                  totals.onDiff
                    ? "Relax the filters, or show superseded results."
                    : "Open a changed file in pull request mode and suggest a mutant on a highlighted line."
                }
              />
            </div>
          </Section>
          {offDiff.length > 0 ? (
            <Section
              title="Other mutants recorded on this pull request"
              description={`Outside the changed lines · ${offDiff.length} of ${totals.offDiff}`}
            >
              <div data-testid="pr-mutants-off-diff">
                <MutantTable mutants={offDiff} showProject={false} />
              </div>
            </Section>
          ) : null}
        </div>
        <aside className="space-y-4">
          <Section
            title="Mutation testing runs"
            description="Ask someone else to run mutation testing on this pull request"
          >
            <div className="space-y-3" data-testid="pr-run-requests">
              {runRequests.length > 0 ? (
                <ul className="space-y-1.5 text-xs">
                  {runRequests.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2">
                      <Link
                        href={routes.projectRunRequest(owner, repo, r.id)}
                        className="min-w-0 truncate hover:underline"
                        data-testid="pr-run-request-link"
                      >
                        Requested by @{r.requestedBy.githubUsername} at{" "}
                        <span className="font-mono">{r.headSha.slice(0, 7)}</span>
                      </Link>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className="text-muted-foreground">{r.reports} reported</span>
                        <RunRequestStatusBadge status={r.displayStatus} />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {openRequest ? null : pr.state !== "OPEN" ? (
                runRequests.length ? null : (
                  <p className="text-muted-foreground text-xs">
                    Runs can be requested while the pull request is open.
                  </p>
                )
              ) : user ? (
                <CreateRunRequestForm
                  projectId={project.id}
                  owner={project.githubOwner}
                  repo={project.githubRepository}
                  number={pr.number}
                  files={files.map((f) => f.path)}
                />
              ) : (
                <p className="text-muted-foreground text-xs">
                  <Link href={routes.signIn(base)} className="underline">
                    Sign in
                  </Link>{" "}
                  to request a mutation testing run.
                </p>
              )}
            </div>
          </Section>
          <Section title="Changed files" description="Open in pull request mode">
            {files.length === 0 ? (
              <EmptyState icon={Bug} title="No changed files with additions" compact />
            ) : (
              <ul className="space-y-1.5 text-xs" data-testid="pull-request-files">
                {files.map((f) => (
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
                    <span className="text-muted-foreground shrink-0 whitespace-nowrap">
                      {f.changedLines} lines ·{" "}
                      <Link
                        href={hrefWith({ file: filter.file === f.path ? undefined : f.path })}
                        className="hover:text-foreground underline-offset-2 hover:underline"
                        title={filter.file === f.path ? "Show all files" : "Show only this file"}
                        aria-current={filter.file === f.path ? "true" : undefined}
                      >
                        {f.mutants} mutant{f.mutants === 1 ? "" : "s"}
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </aside>
      </div>
    </PageContainer>
  );
}
