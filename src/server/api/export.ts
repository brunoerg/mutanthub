import "server-only";
import { summarizeValidations } from "@/domain/mutants/validation-summary";
import { csvHeader, rowToCsv } from "@/domain/dataset/csv";
import { EXPORT_DEFAULT_ROWS, EXPORT_MAX_ROWS, type ExportRow } from "@/domain/dataset/export-row";
import { mutantListFilterSchema } from "@/lib/validation/schemas";
import {
  mutantRepository,
  type MutantExportRecord,
  type MutantListWhere,
} from "@/server/repositories/mutant-repository";
import { projectRepository } from "@/server/repositories/project-repository";
import { referenceLabel } from "@/domain/kill-claims/reference";

export type ExportFormat = "json" | "csv";

/** Flattens a mutant record into the public dataset row. */
export function toExportRow(m: MutantExportRecord, baseUrl: string): ExportRow {
  const summary = summarizeValidations(m.validations.map((v) => v.result));
  const latest = m.submissions[0];
  const killingTestRefs = m.validations
    .map((v) => v.killingTestRef)
    .filter((ref): ref is string => Boolean(ref));
  return {
    id: m.id,
    repository: `${m.project.githubOwner}/${m.project.githubRepository}`,
    language: m.project.language,
    commit: m.revision.commitSha,
    pullRequest: m.pullRequest?.number ?? null,
    file: m.filePath,
    startLine: m.startLine,
    endLine: m.endLine,
    title: m.title,
    description: m.description,
    mutationOperator: m.mutationOperator,
    originalCode: m.originalCode,
    mutatedCode: m.mutatedCode,
    diff: m.gitDiff,
    reviewStatus: m.reviewStatus,
    mutationStatus: m.mutationStatus,
    observedResult: latest?.observedResult ?? null,
    buildCommand: latest?.buildCommand ?? null,
    testCommand: latest?.testCommand ?? null,
    fuzzCommand: latest?.fuzzCommand ?? null,
    environment: latest?.environmentDescription ?? null,
    reproductions: summary.total,
    reproducedSurvived: summary.survived,
    reproducedKilled: summary.killed,
    reproducedCouldNotReproduce: summary.couldNotReproduce,
    killingTestRefs: killingTestRefs.length ? killingTestRefs.join(" | ") : null,
    contributor: m.createdBy.githubUsername,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    url: `${baseUrl}/mutants/${m.id}`,
    killClaims: m.killClaims.length
      ? m.killClaims.map((c) => `${referenceLabel(c.kind, c.reference)} (${c.status})`).join(" | ")
      : null,
    source: m.toolName
      ? `${m.toolName}${m.importBatch?.toolVersion ? ` ${m.importBatch.toolVersion}` : ""}`
      : "manual",
    importBatch: m.importBatchId,
    driftStatus: m.driftStatus,
    driftCheckedCommit: m.driftCommitSha,
  };
}

export interface ExportSelection {
  where: MutantListWhere;
  limit: number;
  /** The filter values that were understood, for echoing back and for snapshots. */
  filters: Record<string, string | number>;
  /** True when a project filter named a project that does not exist. */
  emptyProject: boolean;
}

/** Same filters as the list API plus `limit` (default 10 000, max 50 000). */
export async function parseExportSelection(
  params: Record<string, string>,
): Promise<ExportSelection> {
  const parsed = mutantListFilterSchema.safeParse(params);
  const filter = parsed.success ? parsed.data : mutantListFilterSchema.parse({});
  const rawLimit = Number(params.limit);
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, EXPORT_MAX_ROWS)
      : EXPORT_DEFAULT_ROWS;

  let projectId: string | undefined;
  let emptyProject = false;
  if (filter.project) {
    const [owner, repo] = filter.project.split("/");
    const project = owner && repo ? await projectRepository.findBySlug(owner, repo) : null;
    if (project) projectId = project.id;
    else emptyProject = true;
  }

  const filters: Record<string, string | number> = { limit };
  for (const key of [
    "project",
    "language",
    "operator",
    "reviewStatus",
    "mutationStatus",
    "contributor",
    "commit",
    "file",
    "q",
    "batch",
    "drift",
    "superseded",
    "since",
    "until",
  ] as const) {
    const value = filter[key];
    if (value) filters[key] = value;
  }

  return {
    where: {
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
      superseded: filter.superseded,
      createdSince: filter.since ? new Date(`${filter.since}T00:00:00Z`) : undefined,
      // `until` is inclusive: stop at the start of the following day.
      createdBefore: filter.until
        ? new Date(new Date(`${filter.until}T00:00:00Z`).getTime() + 86_400_000)
        : undefined,
    },
    limit,
    filters,
    emptyProject,
  };
}

/** Collects up to `limit` rows (used for snapshots). */
export async function collectExportRows(
  selection: ExportSelection,
  baseUrl: string,
): Promise<ExportRow[]> {
  if (selection.emptyProject) return [];
  const rows: ExportRow[] = [];
  for await (const batch of mutantRepository.iterateForExport(selection.where, selection.limit)) {
    for (const record of batch) rows.push(toExportRow(record, baseUrl));
  }
  return rows;
}

/** Streams rows straight from the database as JSON array or CSV. */
export function streamExport(
  format: ExportFormat,
  source: AsyncIterable<ExportRow[]>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let first = true;
        if (format === "csv") controller.enqueue(encoder.encode(csvHeader()));
        else controller.enqueue(encoder.encode("[\n"));
        for await (const batch of source) {
          for (const row of batch) {
            if (format === "csv") {
              controller.enqueue(encoder.encode(rowToCsv(row)));
            } else {
              controller.enqueue(encoder.encode(`${first ? "" : ",\n"}${JSON.stringify(row)}`));
              first = false;
            }
          }
        }
        if (format === "json") controller.enqueue(encoder.encode("\n]\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/** Adapts the repository generator to ExportRow batches. */
export async function* exportRowBatches(
  selection: ExportSelection,
  baseUrl: string,
): AsyncGenerator<ExportRow[]> {
  if (selection.emptyProject) return;
  for await (const batch of mutantRepository.iterateForExport(selection.where, selection.limit)) {
    yield batch.map((record) => toExportRow(record, baseUrl));
  }
}

export async function* rowsAsBatches(rows: ExportRow[], size = 500): AsyncGenerator<ExportRow[]> {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
}

export function exportHeaders(format: ExportFormat, filename: string): HeadersInit {
  return {
    "Content-Type":
      format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}.${format}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}
