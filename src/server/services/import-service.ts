import "server-only";
import type { Principal } from "@/domain/auth/permissions";
import { canManageProject } from "@/domain/auth/permissions";
import { locateOriginalCode } from "@/domain/kill-claims/applies";
import { parseImportFile, ImportParseError } from "@/domain/import/parse";
import { prepareRow, type ImportRow, type RowIssue } from "@/domain/import/schema";
import { computeFingerprint } from "@/domain/mutants/fingerprint";
import { generateUnifiedDiff, looksLikeUnifiedDiff } from "@/domain/mutants/diff";
import { AppError, forbidden, validationError } from "@/lib/errors";
import { enforceRateLimit } from "@/server/infra/rate-limit";
import { getGitHubClient } from "@/server/github";
import { isGitHubError } from "@/server/github/types";
import { auditRepository } from "@/server/repositories/audit-repository";
import { importRepository, type ImportMutantData } from "@/server/repositories/import-repository";
import { mutantRepository } from "@/server/repositories/mutant-repository";
import { notificationRepository } from "@/server/repositories/notification-repository";
import type { Prisma, Project, Revision } from "@/generated/prisma/client";
import { projectService } from "./project-service";
import { prisma } from "@/server/db/prisma";

export interface ImportReport {
  toolName: string;
  toolVersion: string | null;
  fileName: string | null;
  total: number;
  valid: number;
  errors: RowIssue[];
  duplicates: RowIssue[];
  /** Distinct commits referenced by valid rows. */
  commits: string[];
}

interface Prepared {
  rows: ImportRow[];
  report: ImportReport;
  revisions: Map<string, Revision>;
  fingerprints: Map<number, string>;
}

/**
 * Bulk import of tool-generated mutants. Project maintainers and admins; rows become approved
 * mutants with the tool's commands as evidence. A dry run validates every row
 * (schema, commit, code location at that commit, duplicates) without writing.
 */
export const importService = {
  async dryRun(
    principal: Principal | null,
    project: Project,
    text: string,
    fileName: string | null,
    override: { toolName?: string; toolVersion?: string } = {},
  ) {
    assertCanImport(principal, project);
    return prepare(project, text, fileName, override);
  },

  async commit(
    principal: Principal | null,
    project: Project,
    text: string,
    fileName: string | null,
    override: { toolName?: string; toolVersion?: string } = {},
  ) {
    assertCanImport(principal, project);
    await enforceRateLimit({
      action: "import",
      subject: principal!.id,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    const prepared = await prepare(project, text, fileName, override);
    if (prepared.rows.length === 0) throw validationError("Nothing to import: no valid rows");

    const mutants: ImportMutantData[] = prepared.rows.map((r) => ({
      revisionId: prepared.revisions.get(r.commit)!.id,
      filePath: r.file,
      startLine: r.startLine,
      endLine: r.endLine,
      originalCode: r.originalCode,
      mutatedCode: r.mutatedCode,
      gitDiff:
        r.diff && looksLikeUnifiedDiff(r.diff)
          ? r.diff
          : generateUnifiedDiff({
              filePath: r.file,
              startLine: r.startLine,
              originalCode: r.originalCode,
              mutatedCode: r.mutatedCode,
            }),
      mutationOperator: r.mutationOperator,
      title: r.title,
      description: r.description,
      fingerprint: prepared.fingerprints.get(r.index)!,
      mutationStatus: r.observedResult,
      externalId: r.externalId,
      submission: {
        buildCommand: r.buildCommand,
        testCommand: r.testCommand,
        fuzzCommand: r.fuzzCommand,
        testDurationSeconds: r.testDurationSeconds,
        environmentDescription: r.environment,
        observedResult: r.observedResult,
        notes: r.notes,
      },
    }));

    const { batch, ids } = await importRepository.createBatch({
      projectId: project.id,
      importedById: principal!.id,
      toolName: prepared.report.toolName,
      toolVersion: prepared.report.toolVersion,
      fileName,
      rowCount: prepared.report.total,
      skippedCount: prepared.report.duplicates.length,
      errorCount: prepared.report.errors.length,
      report: JSON.parse(
        JSON.stringify({ errors: prepared.report.errors, duplicates: prepared.report.duplicates }),
      ) as Prisma.InputJsonValue,
      mutants,
    });

    await auditRepository.record({
      actorId: principal!.id,
      action: "MUTANTS_IMPORTED",
      projectId: project.id,
      targetType: "project",
      targetId: project.id,
      metadata: {
        batchId: batch.id,
        tool: prepared.report.toolName,
        created: ids.length,
        skipped: prepared.report.duplicates.length,
        errors: prepared.report.errors.length,
      },
    });
    await notifyReviewers(project, principal!.id, ids.length, prepared.report.toolName);
    return { batch, createdIds: ids, report: prepared.report };
  },

  listBatches(projectId: string) {
    return importRepository.listForProject(projectId);
  },
};

function assertCanImport(
  principal: Principal | null,
  project: Project,
): asserts principal is Principal {
  if (!principal || !canManageProject(principal, project.id))
    throw forbidden("Only project maintainers and administrators can import mutants");
}

async function prepare(
  project: Project,
  text: string,
  fileName: string | null,
  override: { toolName?: string; toolVersion?: string },
): Promise<Prepared> {
  let parsed;
  try {
    parsed = parseImportFile(text);
  } catch (error) {
    if (error instanceof ImportParseError)
      throw validationError(error.message, { file: error.message });
    throw error;
  }
  const toolName = override.toolName?.trim() || parsed.tool.name || "unknown tool";
  const toolVersion = override.toolVersion?.trim() || parsed.tool.version || null;

  const errors: RowIssue[] = [];
  const duplicates: RowIssue[] = [];
  const rows: ImportRow[] = [];
  for (const [index, raw] of parsed.rows.entries()) {
    const result = prepareRow(raw, index, parsed.defaults, {
      name: toolName,
      version: toolVersion ?? undefined,
    });
    if (result.ok) rows.push(result.row);
    else errors.push(result.issue);
  }

  // Resolve commits once each; rows on unknown commits become errors.
  const client = getGitHubClient();
  const revisions = new Map<string, Revision>();
  const commitErrors = new Map<string, string>();
  for (const commit of new Set(rows.map((r) => r.commit))) {
    try {
      const { revision } = await projectService.ensureRevision(project, commit);
      revisions.set(commit, revision);
    } catch (e) {
      commitErrors.set(
        commit,
        isGitHubError(e) && e.kind === "NOT_FOUND"
          ? "commit not found in the repository"
          : `could not resolve commit (${(e as Error).message})`,
      );
      if (isGitHubError(e) && e.kind === "RATE_LIMITED")
        throw new AppError("UPSTREAM", "GitHub rate limit reached. Please try again later.");
    }
  }

  // Location check: the original code must be at the stated line of that commit.
  const fileCache = new Map<string, string | null>();
  const fingerprints = new Map<number, string>();
  const seen = new Map<string, number>();
  const accepted: ImportRow[] = [];
  for (const row of rows) {
    const revision = revisions.get(row.commit);
    if (!revision) {
      errors.push({
        index: row.index,
        message: `commit ${row.commit.slice(0, 7)}: ${commitErrors.get(row.commit) ?? "unresolved"}`,
      });
      continue;
    }
    const key = `${revision.commitSha}:${row.file}`;
    if (!fileCache.has(key)) {
      try {
        const file = await client.getFile(
          project.githubOwner,
          project.githubRepository,
          revision.commitSha,
          row.file,
        );
        fileCache.set(key, file.content);
      } catch (e) {
        if (isGitHubError(e) && e.kind === "RATE_LIMITED")
          throw new AppError("UPSTREAM", "GitHub rate limit reached. Please try again later.");
        fileCache.set(key, null);
      }
    }
    const content = fileCache.get(key);
    if (content == null) {
      errors.push({
        index: row.index,
        message: `${row.file}: file not found at ${row.commit.slice(0, 7)} (or too large to check)`,
      });
      continue;
    }
    const located = locateOriginalCode(content, row.originalCode, row.startLine);
    if (located.applies !== "APPLIES") {
      errors.push({
        index: row.index,
        message:
          located.applies === "MOVED"
            ? `${row.file}:${row.startLine}: originalCode found at line ${located.line}, not ${row.startLine}`
            : `${row.file}:${row.startLine}: originalCode not found at ${row.commit.slice(0, 7)}`,
      });
      continue;
    }
    const fingerprint = computeFingerprint({
      projectId: project.id,
      revisionId: revision.id,
      filePath: row.file,
      startLine: row.startLine,
      originalCode: row.originalCode,
      mutatedCode: row.mutatedCode,
    });
    const earlier = seen.get(fingerprint);
    if (earlier !== undefined) {
      duplicates.push({
        index: row.index,
        message: `duplicate of row ${earlier + 1} in this file`,
      });
      continue;
    }
    const existing = await mutantRepository.findByFingerprint(fingerprint);
    if (existing.length > 0) {
      duplicates.push({
        index: row.index,
        message: `already in the catalogue as #${existing[0].id}`,
        existingId: existing[0].id,
      });
      continue;
    }
    seen.set(fingerprint, row.index);
    fingerprints.set(row.index, fingerprint);
    accepted.push(row);
  }

  errors.sort((a, b) => a.index - b.index);
  const report: ImportReport = {
    toolName,
    toolVersion,
    fileName,
    total: parsed.rows.length,
    valid: accepted.length,
    errors,
    duplicates,
    commits: [...revisions.keys()],
  };
  return { rows: accepted, report, revisions, fingerprints };
}

/** One notification per reviewer for the whole batch. */
async function notifyReviewers(
  project: Project,
  actorId: string,
  created: number,
  toolName: string,
): Promise<void> {
  const reviewers = await prisma.projectMember.findMany({
    where: {
      projectId: project.id,
      role: { in: ["REVIEWER", "MAINTAINER"] },
      userId: { not: actorId },
    },
    select: { userId: true },
  });
  if (reviewers.length === 0) return;
  await notificationRepository.createMany(
    reviewers.map((r) => ({
      userId: r.userId,
      type: "MUTANTS_IMPORTED" as const,
      actorId,
      mutantId: null,
      projectId: project.id,
      title: `${created} mutants imported into ${project.displayName} from ${toolName}`,
      body: "They were created as approved; reproductions and comments work as usual.",
    })),
  );
}
