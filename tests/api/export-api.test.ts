import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutantDetail, MutantExportRecord } from "@/server/repositories/mutant-repository";

const { iterateMock, findBySlugMock, detailMock } = vi.hoisted(() => ({
  iterateMock: vi.fn(),
  findBySlugMock: vi.fn(),
  detailMock: vi.fn(),
}));

vi.mock("@/server/repositories/mutant-repository", () => ({
  mutantRepository: { iterateForExport: iterateMock },
}));
vi.mock("@/server/repositories/project-repository", () => ({
  projectRepository: { findBySlug: findBySlugMock },
}));
vi.mock("@/server/services/mutant-service", () => ({
  mutantService: { getDetail: detailMock },
}));

import { GET as csvGet } from "@/app/api/export/mutants.csv/route";
import { GET as jsonGet } from "@/app/api/export/mutants.json/route";
import { GET as patchGet } from "@/app/api/mutants/[id]/patch/route";
import { resetRateLimits } from "@/server/infra/rate-limit";

function record(id: number): MutantExportRecord {
  const now = new Date("2026-09-01T10:00:00Z");
  return {
    id,
    title: `Mutant ${id}, "quoted"`,
    description: null,
    filePath: "lib/url.c",
    startLine: 10 + id,
    endLine: 10 + id,
    mutationOperator: "RELATIONAL_OPERATOR",
    originalCode: "a > b",
    mutatedCode: "a >= b",
    gitDiff: "-a > b\n+a >= b\n",
    reviewStatus: "APPROVED",
    mutationStatus: "SURVIVED",
    createdAt: now,
    updatedAt: now,
    project: { githubOwner: "curl", githubRepository: "curl", language: "C" },
    revision: { commitSha: "e8d1c4b7" },
    pullRequest: null,
    createdBy: { githubUsername: "frank" },
    submissions: [
      {
        observedResult: "SURVIVED",
        buildCommand: null,
        testCommand: "make test-ci",
        fuzzCommand: null,
        environmentDescription: "Ubuntu",
      },
    ],
    validations: [
      { result: "SURVIVED", killingTestRef: null },
      { result: "KILLED", killingTestRef: "tests/unit/unit1300.c" },
    ],
    killClaims: [{ kind: "PULL_REQUEST", reference: "15908", status: "CLAIMED" }],
    toolName: null,
    importBatchId: null,
    importBatch: null,
    driftStatus: "UNCHECKED" as const,
    driftCommitSha: null,
    driftLine: null,
  };
}

async function* batches(records: MutantExportRecord[]) {
  yield records;
}

describe("bulk export routes", () => {
  beforeEach(async () => {
    iterateMock.mockReset();
    findBySlugMock.mockReset();
    await resetRateLimits();
  });

  it("streams CSV with a header and quoted multi-line fields", async () => {
    iterateMock.mockImplementation(() => batches([record(1), record(2)]));
    const res = await csvGet(new Request("http://localhost:3000/api/export/mutants.csv?limit=2"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(
      /mutanthub-mutants-\d{4}-\d{2}-\d{2}\.csv/,
    );
    expect(res.headers.get("x-export-limit")).toBe("2");
    const text = await res.text();
    const lines = text.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0].startsWith("id,repository,")).toBe(true);
    expect(lines[1]).toContain('"Mutant 1, ""quoted"""');
    expect(text).toContain('"-a > b\n+a >= b\n"');
    expect(iterateMock).toHaveBeenCalledWith(expect.objectContaining({ projectId: undefined }), 2);
  });

  it("streams a JSON array with flattened rows", async () => {
    iterateMock.mockImplementation(() => batches([record(1)]));
    const res = await jsonGet(new Request("http://localhost:3000/api/export/mutants.json"));
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 1,
      repository: "curl/curl",
      commit: "e8d1c4b7",
      reproductions: 2,
      reproducedSurvived: 1,
      reproducedKilled: 1,
      killingTestRefs: "tests/unit/unit1300.c",
      testCommand: "make test-ci",
      url: "http://localhost:3000/mutants/1",
      killClaims: "PR #15908 (CLAIMED)",
      source: "manual",
      importBatch: null,
      driftStatus: "UNCHECKED",
      driftCheckedCommit: null,
    });
    expect(res.headers.get("x-export-limit")).toBe("10000");
  });

  it("resolves project filters and returns an empty array for unknown projects", async () => {
    findBySlugMock.mockResolvedValue(null);
    const res = await jsonGet(
      new Request("http://localhost:3000/api/export/mutants.json?project=nobody/nothing"),
    );
    expect(await res.json()).toEqual([]);
    expect(iterateMock).not.toHaveBeenCalled();

    findBySlugMock.mockResolvedValue({ id: "p1" });
    iterateMock.mockImplementation(() => batches([]));
    await jsonGet(
      new Request("http://localhost:3000/api/export/mutants.json?project=curl/curl&limit=999999"),
    );
    expect(iterateMock).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1" }), 50_000);
  });

  it("passes drift, batch and date filters through to the query", async () => {
    iterateMock.mockImplementation(() => batches([]));
    await jsonGet(
      new Request(
        "http://localhost:3000/api/export/mutants.json?mutationStatus=SURVIVED&drift=APPLIES&batch=b1&since=2026-09-01&until=2026-09-30&superseded=hide",
      ),
    );
    expect(iterateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationStatus: "SURVIVED",
        driftStatus: "APPLIES",
        importBatchId: "b1",
        superseded: "hide",
        createdSince: new Date("2026-09-01T00:00:00Z"),
        createdBefore: new Date("2026-10-01T00:00:00Z"),
      }),
      10_000,
    );
  });
});

describe("GET /api/mutants/:id/patch", () => {
  it("serves the stored diff as a patch download", async () => {
    detailMock.mockResolvedValue({
      mutant: {
        id: 5,
        title: "Off by one",
        gitDiff: "--- a/x\n+++ b/x\n-1\n+2",
        filePath: "x",
        startLine: 3,
        endLine: 3,
        reviewStatus: "APPROVED",
        mutationStatus: "SURVIVED",
        project: { githubOwner: "curl", githubRepository: "curl" },
        revision: { commitSha: "abc" },
      } as unknown as MutantDetail,
    });
    const res = await patchGet(new Request("http://localhost:3000/api/mutants/5/patch"), {
      params: Promise.resolve({ id: "5" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-patch");
    const body = await res.text();
    expect(body.startsWith("# MutantHub mutant #5: Off by one\n")).toBe(true);
    expect(body.endsWith("-1\n+2\n")).toBe(true);
  });
});
