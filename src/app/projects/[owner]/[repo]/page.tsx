import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Bug,
  Code2,
  ExternalLink,
  FileCode2,
  FlaskConical,
  GitCommitHorizontal,
  GitPullRequest,
  Settings,
} from "lucide-react";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Section } from "@/components/shared/section";
import { Stat } from "@/components/shared/stat";
import { UserChip } from "@/components/shared/user-chip";
import { EmptyState } from "@/components/shared/empty-state";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { MutantTable } from "@/components/mutants/mutant-table";
import { StatusPill, ValidationResultBadge } from "@/components/mutants/status-badge";
import { FollowButton } from "@/components/projects/follow-button";
import { canManageProject } from "@/domain/auth/permissions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/server/auth/session";
import { projectService } from "@/server/services/project-service";
import { runRequestService } from "@/server/services/run-request-service";
import { isAppError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import { absoluteDate, relativeTime, shortSha } from "@/lib/format";

type Params = Promise<{ owner: string; repo: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { owner, repo } = await params;
  return { title: `${owner}/${repo}` };
}

export default async function ProjectOverviewPage({ params }: { params: Params }) {
  const { owner, repo } = await params;
  const user = await getCurrentUser();

  let project;
  try {
    project = await projectService.getBySlugOrThrow(owner, repo);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }

  const [overview, head, following, openRunRequests] = await Promise.all([
    projectService.getOverview(project),
    projectService.getHeadCommit(project),
    projectService.isFollowing(user, project.id),
    runRequestService.countOpen(project),
  ]);
  const { counts, drift } = overview;
  const codeRef = head?.sha ?? project.defaultBranch;

  return (
    <PageContainer wide>
      <div data-testid="project-overview">
        <PageHeader
          eyebrow={
            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>{project.language ?? "Unknown language"}</span>
              <span className="font-mono">{project.defaultBranch}</span>
              {head ? (
                <a
                  href={routes.github.commit(
                    project.githubOwner,
                    project.githubRepository,
                    head.sha,
                  )}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono hover:underline"
                  title={head.message.split("\n")[0]}
                >
                  <GitCommitHorizontal className="size-3" aria-hidden />
                  head {shortSha(head.sha)}
                </a>
              ) : (
                <span>head unavailable</span>
              )}
            </span>
          }
          title={
            <span className="font-mono">
              {project.githubOwner}/{project.githubRepository}
            </span>
          }
          description={project.description ?? "No description provided on GitHub."}
          actions={
            <>
              {canManageProject(user, project.id) ? (
                <Button asChild variant="outline" size="sm" data-testid="project-settings-link">
                  <Link
                    href={routes.projectSettings(project.githubOwner, project.githubRepository)}
                  >
                    <Settings className="size-3.5" aria-hidden /> Settings
                  </Link>
                </Button>
              ) : null}
              {user ? (
                <FollowButton
                  projectId={project.id}
                  owner={project.githubOwner}
                  repo={project.githubRepository}
                  following={following}
                />
              ) : null}
              <Button asChild variant="outline" size="sm">
                <a
                  href={routes.github.repo(project.githubOwner, project.githubRepository)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="size-3.5" aria-hidden /> View repository on GitHub
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={routes.projectMutants(project.githubOwner, project.githubRepository)}>
                  <Bug className="size-3.5" aria-hidden /> All mutants
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm" data-testid="project-pulls-link">
                <Link href={routes.projectPulls(project.githubOwner, project.githubRepository)}>
                  <GitPullRequest className="size-3.5" aria-hidden /> Pull requests
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm" data-testid="project-run-requests-link">
                <Link
                  href={routes.projectRunRequests(project.githubOwner, project.githubRepository)}
                >
                  <FlaskConical className="size-3.5" aria-hidden /> Run requests
                  {openRunRequests ? (
                    <span className="bg-muted rounded px-1 font-mono text-[10px]">
                      {openRunRequests}
                    </span>
                  ) : null}
                </Link>
              </Button>
              <Button asChild size="sm" data-testid="browse-code">
                <Link href={routes.projectCode(project.githubOwner, project.githubRepository)}>
                  <Code2 className="size-3.5" aria-hidden /> Browse code
                </Link>
              </Button>
            </>
          }
        />

        {!project.isActive ? (
          <Alert className="mt-4" data-testid="project-inactive-notice">
            <AlertTitle>This project is inactive</AlertTitle>
            <AlertDescription>
              It is hidden from the project list and does not accept new submissions. Existing
              mutants, reproductions and discussions remain readable.
            </AlertDescription>
          </Alert>
        ) : null}

        <p className="text-muted-foreground mt-3 text-xs">
          Mutants always refer to the exact commit they were created against. Line numbers on newer
          commits may no longer match.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Total mutants" value={counts.total} />
          <Stat label="Surviving" value={counts.surviving} tone="warning" />
          <Stat label="Killed" value={counts.killed} tone="success" />
          <Stat label="Equivalent" value={counts.equivalent} tone="info" />
          <Stat
            label="Pending review"
            value={counts.pendingReview + counts.needsInformation}
            hint={
              counts.needsInformation ? `${counts.needsInformation} need information` : undefined
            }
          />
          <Stat
            label="Drifted at HEAD"
            value={drift.moved + drift.gone}
            tone={drift.gone ? "danger" : "warning"}
            hint={
              project.driftCheckedAt
                ? `${drift.gone} gone, ${drift.moved} moved · checked ${relativeTime(project.driftCheckedAt)}`
                : "not checked yet"
            }
          />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Section
              title="Recent mutants"
              actions={
                <Button asChild variant="ghost" size="xs">
                  <Link href={routes.projectMutants(project.githubOwner, project.githubRepository)}>
                    View all
                  </Link>
                </Button>
              }
            >
              <MutantTable
                mutants={overview.recentMutants}
                showProject={false}
                emptyTitle="No mutants yet"
                emptyDescription="Browse the code, select a line and suggest the first mutant."
              />
            </Section>

            <Section
              title="Recent validations"
              description="Reproduction attempts by the community."
            >
              {overview.recentValidations.length === 0 ? (
                <EmptyState title="No reproductions yet" compact />
              ) : (
                <ul className="divide-border divide-y">
                  {overview.recentValidations.map((v) => (
                    <li
                      key={v.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                    >
                      <UserChip user={v.user} size="xs" />
                      <ValidationResultBadge result={v.result} />
                      <Link
                        href={routes.mutant(v.mutant.id)}
                        className="min-w-0 truncate hover:underline"
                      >
                        <span className="text-muted-foreground font-mono text-xs">
                          #{v.mutant.id}
                        </span>{" "}
                        {v.mutant.title}
                      </Link>
                      <span className="text-muted-foreground ml-auto text-xs">
                        {relativeTime(v.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Recent activity">
              <ActivityFeed items={overview.recentActivity} />
            </Section>
          </div>

          <div className="space-y-4">
            <Section title="Most affected files">
              {overview.topFiles.length === 0 ? (
                <EmptyState icon={FileCode2} title="No files yet" compact />
              ) : (
                <ul className="space-y-1">
                  {overview.topFiles.map((f) => (
                    <li
                      key={f.filePath}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <Link
                        href={routes.projectCode(
                          project.githubOwner,
                          project.githubRepository,
                          f.filePath,
                          { ref: codeRef },
                        )}
                        className="min-w-0 truncate font-mono text-xs hover:underline"
                        title={f.filePath}
                      >
                        {f.filePath}
                      </Link>
                      <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
                        {f.count}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Top contributors">
              {overview.topContributors.length === 0 ? (
                <EmptyState title="No contributors yet" compact />
              ) : (
                <ul className="space-y-1.5">
                  {overview.topContributors.map((c) => (
                    <li key={c.user.id} className="flex items-center justify-between gap-2">
                      <UserChip user={c.user} size="xs" />
                      <span className="text-muted-foreground font-mono text-xs tabular-nums">
                        {c.count} mutants
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Members">
              {overview.members.length === 0 ? (
                <EmptyState title="No members" compact />
              ) : (
                <ul className="space-y-1.5">
                  {overview.members.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-2">
                      <UserChip user={m.user} size="xs" />
                      <StatusPill
                        tone={
                          m.role === "MAINTAINER"
                            ? "info"
                            : m.role === "REVIEWER"
                              ? "success"
                              : "muted"
                        }
                        dot={false}
                      >
                        {m.role.toLowerCase()}
                      </StatusPill>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Revisions with mutants">
              {overview.revisions.length === 0 ? (
                <EmptyState icon={GitCommitHorizontal} title="No revisions yet" compact />
              ) : (
                <ul className="space-y-1.5">
                  {overview.revisions.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                      <div className="min-w-0">
                        <a
                          href={routes.github.commit(
                            project.githubOwner,
                            project.githubRepository,
                            r.commitSha,
                          )}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs hover:underline"
                          title={r.commitMessage ?? undefined}
                        >
                          {shortSha(r.commitSha)}
                        </a>
                        {r.branch ? (
                          <span className="text-muted-foreground ml-1.5 text-xs">{r.branch}</span>
                        ) : null}
                        <div className="text-muted-foreground text-xs">
                          {r.commitDate ? absoluteDate(r.commitDate) : "date unknown"}
                        </div>
                      </div>
                      <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
                        {r._count.mutants}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
