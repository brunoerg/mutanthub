import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { projectService } from "@/server/services/project-service";
import { runRequestService } from "@/server/services/run-request-service";
import { isAppError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Section } from "@/components/shared/section";
import { CreateRunRequestForm } from "@/components/run-requests/create-run-request-form";
import { RunRequestTable } from "@/components/run-requests/run-request-table";

export const dynamic = "force-dynamic";

type Params = Promise<{ owner: string; repo: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const FILTERS = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
] as const;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { owner, repo } = await params;
  return { title: `Run requests · ${owner}/${repo}` };
}

export default async function ProjectRunRequestsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { owner, repo } = await params;
  const rawStatus = (await searchParams).status;
  const filter = FILTERS.find((f) => f.value === rawStatus)?.value ?? "open";
  const user = await getCurrentUser();
  let project;
  try {
    project = await projectService.getBySlugOrThrow(owner, repo);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const requests = await runRequestService.listForProject(project, filter);

  return (
    <PageContainer className="space-y-4" wide>
      <div data-testid="project-run-requests">
        <PageHeader
          eyebrow={
            <Link href={routes.project(owner, repo)} className="font-mono hover:underline">
              {project.githubOwner}/{project.githubRepository}
            </Link>
          }
          title="Run requests"
          description="Pull requests whose authors or reviewers would like someone to run mutation testing. Claim one, run your tool against the requested commit, report what you ran and submit the surviving mutants."
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <nav className="flex gap-1 text-xs" aria-label="Filter requests">
            {FILTERS.map((f) => (
              <Link
                key={f.value}
                href={routes.projectRunRequests(
                  owner,
                  repo,
                  f.value === "open" ? undefined : f.value,
                )}
                aria-current={filter === f.value ? "page" : undefined}
                className={cn(
                  "rounded-md border px-2 py-1",
                  filter === f.value
                    ? "border-foreground/30 bg-muted font-medium"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
                data-testid={`run-request-filter-${f.value}`}
              >
                {f.label}
              </Link>
            ))}
          </nav>
          <RunRequestTable
            owner={owner}
            repo={repo}
            requests={requests}
            emptyTitle={filter === "open" ? "No open run requests" : "No run requests"}
            emptyDescription={
              filter === "open"
                ? "Ask for a run on a pull request, or follow the project to hear about new requests."
                : undefined
            }
          />
        </div>
        <aside>
          <Section title="Request a run">
            {user ? (
              <CreateRunRequestForm
                projectId={project.id}
                owner={project.githubOwner}
                repo={project.githubRepository}
              />
            ) : (
              <p className="text-muted-foreground text-xs">
                <Link
                  href={routes.signIn(routes.projectRunRequests(owner, repo))}
                  className="underline"
                >
                  Sign in
                </Link>{" "}
                to request a mutation testing run.
              </p>
            )}
          </Section>
        </aside>
      </div>
    </PageContainer>
  );
}
