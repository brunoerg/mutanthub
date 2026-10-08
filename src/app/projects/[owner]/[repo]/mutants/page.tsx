import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Braces, Code2, LayoutDashboard } from "lucide-react";
import { projectService } from "@/server/services/project-service";
import { mutantService } from "@/server/services/mutant-service";
import { userRepository } from "@/server/repositories/user-repository";
import { isAppError } from "@/lib/errors";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Pagination } from "@/components/shared/pagination";
import { MutantTable } from "@/components/mutants/mutant-table";
import {
  MutantFilters,
  buildQuery,
  supersededView,
  type MutantFilterValues,
} from "@/components/mutants/mutant-filters";
import { Button } from "@/components/ui/button";
import { routes } from "@/lib/routes";

export const dynamic = "force-dynamic";

type Params = { owner: string; repo: string };
type SearchParams = Record<string, string | string[] | undefined>;

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { owner, repo } = await params;
  return { title: `${owner}/${repo} · mutants` };
}

async function loadProject(owner: string, repo: string) {
  try {
    return await projectService.getBySlugOrThrow(owner, repo);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
}

function firstValues(sp: SearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (value) out[k] = value;
  }
  return out;
}

export default async function ProjectMutantsPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<SearchParams>;
}) {
  const { owner, repo } = await params;
  const project = await loadProject(owner, repo);
  const slug = `${project.githubOwner}/${project.githubRepository}`;
  const sp = firstValues(await searchParams);
  const raw = { ...sp, project: slug };
  const superseded = supersededView(sp.superseded);
  const [{ items, total, filter }, contributors] = await Promise.all([
    mutantService.list({ ...raw, superseded: superseded.filter }),
    userRepository.listMutantContributors(project.id),
  ]);

  const values: MutantFilterValues = {
    project: slug,
    operator: filter.operator,
    reviewStatus: filter.reviewStatus,
    mutationStatus: filter.mutationStatus,
    contributor: filter.contributor,
    commit: filter.commit,
    file: filter.file,
    q: filter.q,
    batch: filter.batch,
    drift: filter.drift,
    superseded: superseded.view,
    since: filter.since,
    until: filter.until,
    sort: filter.sort,
  };
  const query = {
    ...values,
    project: undefined,
    pageSize: filter.pageSize !== 25 ? filter.pageSize : undefined,
  };
  const base = routes.projectMutants(project.githubOwner, project.githubRepository);
  const apiHref = `/api/mutants${buildQuery({ ...values, superseded: filter.superseded, page: filter.page })}`;

  return (
    <PageContainer wide className="space-y-4" data-testid="project-mutants-page">
      <PageHeader
        eyebrow={
          <Link
            href={routes.project(project.githubOwner, project.githubRepository)}
            className="font-mono hover:underline"
          >
            {slug}
          </Link>
        }
        title="Mutants"
        description={project.description ?? undefined}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={routes.project(project.githubOwner, project.githubRepository)}>
                <LayoutDashboard className="size-3.5" aria-hidden /> Overview
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={routes.projectCode(project.githubOwner, project.githubRepository)}>
                <Code2 className="size-3.5" aria-hidden /> Browse code
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a href={apiHref} target="_blank" rel="noreferrer">
                <Braces className="size-3.5" aria-hidden /> API
              </a>
            </Button>
          </>
        }
      />
      <MutantFilters
        action={base}
        values={values}
        projects={[]}
        contributors={contributors}
        lockProject
      />
      <div className="text-muted-foreground text-xs" data-testid="mutant-count">
        {total} mutant{total === 1 ? "" : "s"}
        {filter.file ? (
          <>
            {" "}
            in <span className="font-mono">{filter.file}</span>
          </>
        ) : null}
      </div>
      <MutantTable
        mutants={items}
        showProject={false}
        emptyDescription="Browse the code and suggest the first mutant for this project."
      />
      <Pagination
        page={filter.page}
        pageSize={filter.pageSize}
        total={total}
        hrefFor={(page) => `${base}${buildQuery({ ...query, page })}`}
      />
    </PageContainer>
  );
}
