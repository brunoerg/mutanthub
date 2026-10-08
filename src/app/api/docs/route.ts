import { NextResponse } from "next/server";

export const dynamic = "force-static";

/** Machine-readable description of the public API (a minimal OpenAPI 3.1 document). */
export function GET() {
  return NextResponse.json(OPENAPI);
}

const filterParams = [
  ["project", "Repository in owner/repo form, e.g. curl/curl"],
  ["language", "Primary language of the project, e.g. C++"],
  ["operator", "Mutation operator enum value"],
  ["reviewStatus", "PENDING | NEEDS_INFORMATION | APPROVED | REJECTED | DUPLICATE | WITHDRAWN"],
  ["mutationStatus", "UNKNOWN | SURVIVED | KILLED | EQUIVALENT | INVALID"],
  ["contributor", "GitHub username of the submitter"],
  ["commit", "Commit SHA prefix"],
  ["file", "Substring of the file path"],
  ["q", "Free text over title, description, code and path"],
  [
    "superseded",
    "hide | only. A mutant is superseded when the same mutation has a newer result at a later commit; hide keeps the latest result per mutation",
  ],
  ["since", "Created on or after this day, YYYY-MM-DD (UTC)"],
  ["until", "Created on or before this day, YYYY-MM-DD (UTC)"],
  ["sort", "oldest for oldest first; newest first when omitted"],
  ["page", "1-based page number (default 1)"],
  ["pageSize", "Items per page, 1-100 (default 25)"],
].map(([name, description]) => ({
  name,
  in: "query",
  required: false,
  schema: { type: "string" },
  description,
}));

const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "MutantHub public API",
    version: "0.1.0",
    description:
      "Read-only access to the community mutant catalogue. Commands and patches are provided as text and are never executed by the platform. Rate limit: 120 requests per minute per IP.",
  },
  paths: {
    "/api/mutants": {
      get: {
        summary: "List mutants",
        parameters: filterParams,
        responses: {
          "200": {
            description: "Paginated list",
            content: {
              "application/json": {
                example: {
                  data: [
                    {
                      id: 182,
                      repository: "bitcoin/bitcoin",
                      commit: "abc123...",
                      file: "src/script/interpreter.cpp",
                      startLine: 421,
                      endLine: 421,
                      title: "Relax bounds check in CheckMinimalPush",
                      mutationOperator: "RELATIONAL_OPERATOR",
                      reviewStatus: "APPROVED",
                      mutationStatus: "SURVIVED",
                      reproductions: 4,
                      reproductionSummary: {
                        survived: 4,
                        killed: 0,
                        couldNotReproduce: 0,
                        consensus: "SURVIVED",
                      },
                      contributor: "alice",
                      createdAt: "2026-09-01T10:00:00.000Z",
                      updatedAt: "2026-09-03T10:00:00.000Z",
                      url: "https://example.com/mutants/182",
                    },
                  ],
                  pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
                },
              },
            },
          },
          "429": { description: "Rate limit exceeded" },
        },
      },
    },
    "/api/mutants/{id}": {
      get: {
        summary: "Get one mutant with diff, test evidence, validations and status history",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "Mutant" }, "404": { description: "Not found" } },
      },
    },
  },
};
