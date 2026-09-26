How project maintainers and administrators bulk-import the output of a mutation testing tool: the file format, what is checked, and what gets created.

# Importing mutants

Running a mutation testing tool over a file typically yields dozens or hundreds of surviving
mutants. Instead of suggesting them one by one, a project maintainer or administrator can upload the tool's output
and import all of them at once from **Project → Settings → Import mutants**
(`/projects/<owner>/<repo>/import`).

Imports are restricted to the project's maintainers and global administrators
(`ADMIN_GITHUB_USERNAMES`) because the mutants
are created **directly as approved**: the tool's run is taken as the evidence a reviewer would
otherwise ask for. Everything else works as for hand-written mutants: reproductions, comments,
killing-test claims, classification and exports.

The server never runs anything from the file. Commands are stored as text and shown as
reproduction instructions, exactly like the fields of the suggest-mutant form.

## Workflow

1. **Check file** uploads the file and returns a report without writing anything: how many rows
   are ready, which rows are duplicates (of each other or of mutants already in the catalogue,
   with a link) and which rows have errors, each with its row number and reason.
2. **Import N mutants as approved** re-validates and writes the valid rows in one transaction.
   Rows with errors or duplicates are skipped, never partially imported.
3. The result links to the project's mutant list filtered by the new batch
   (`/projects/<owner>/<repo>/mutants?batch=<id>`). Previous imports are listed on the import
   page with their counts.

Reviewers and maintainers of the project receive one notification per import; the project
activity feed and the audit trail record the import with the tool name and the counts.

## File format

Three shapes are accepted, all UTF-8, up to 20 MB and 2,000 rows per file:

- a JSON array of rows;
- a JSON object `{ "tool": {...}, "defaults": {...}, "mutants": [rows] }`;
- JSON Lines: one row per line, optionally preceded by a header line
  `{ "tool": {...}, "defaults": {...} }`.

Field names match the [dataset export](dataset.md). A complete example that imports against the
mocked `curl/curl` fixture is in [`docs/examples/import-example.json`](examples/import-example.json).

```json
{
  "tool": { "name": "mull", "version": "0.24.0" },
  "defaults": {
    "commit": "9b2e4d6f8a0c1e3b5d7f9a1c3e5b7d9f1a3c5e7b",
    "buildCommand": "cmake -B build && cmake --build build -j8",
    "testCommand": "ctest --test-dir build --output-on-failure",
    "environment": "Ubuntu 24.04, clang 18",
    "observedResult": "SURVIVED"
  },
  "mutants": [
    {
      "file": "src/script/interpreter.cpp",
      "startLine": 60,
      "originalCode": "    } else if (data.size() <= 75) {",
      "mutatedCode": "    } else if (data.size() < 75) {",
      "mutationOperator": "RELATIONAL_OPERATOR",
      "tool": { "mutantId": "cxx_le_to_lt:60:34" }
    }
  ]
}
```

### Row fields

| Field                                                         | Required          | Notes                                                                           |
| ------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| `commit`                                                      | row or `defaults` | Full 40-character SHA the tool ran against; it is recorded as a revision        |
| `file`                                                        | yes               | Repository-relative path                                                        |
| `startLine`                                                   | yes               | 1-based line of `originalCode` at that commit                                   |
| `endLine`                                                     | no                | Defaults to `startLine`                                                         |
| `originalCode`                                                | yes               | Must be found at `startLine` in the file at `commit` (whitespace-insensitive)   |
| `mutatedCode`                                                 | yes               | Must differ from `originalCode`; empty means the lines are deleted              |
| `diff`                                                        | no                | Unified diff; generated from the two snippets when absent                       |
| `mutationOperator`                                            | no                | One of the catalogue values (`RELATIONAL_OPERATOR`, ...); defaults to `UNKNOWN` |
| `title`                                                       | no                | Generated as `<operator> mutation at <file>:<line>` when absent                 |
| `description`                                                 | no                | Markdown                                                                        |
| `observedResult`                                              | row or `defaults` | `SURVIVED`, `KILLED` or `UNKNOWN`; becomes the mutant's initial outcome         |
| `testCommand`                                                 | row or `defaults` | Stored as text, shown as reproduction instructions                              |
| `environment`                                                 | no                | Free text; recommended so others can reproduce the run                          |
| `buildCommand`, `fuzzCommand`, `testDurationSeconds`, `notes` | no                | As in the suggest-mutant form                                                   |
| `tool.mutantId` / `externalId`                                | no                | The tool's own identifier, kept as `externalId` for traceability                |

`tool.name` and `tool.version` from the file (or the overrides typed on the import page) are
stored on the batch and on every mutant, appear in the mutant's history ("Imported from mull
0.24.0 by an administrator") and in the `source` column of exports.

## What is checked

- Row schema and size limits (same limits as the form: title, description, code, commands).
- Each distinct commit must exist in the repository; unknown commits fail every row that uses
  them. Commits are fetched once and become revisions of the project.
- The file must exist at that commit and `originalCode` must be at `startLine`. Code found at
  another line is reported as an error with the line where it was found, so the tool's output
  can be fixed rather than imported at the wrong place.
- Duplicates are detected with the same fingerprint as manual submissions (project, revision,
  file, start line, original and mutated code), both within the file and against the catalogue.
  The same mutation at two different lines is two mutants, not a duplicate.

Rate limit: 20 imports per administrator per hour. GitHub rate limiting aborts the import with a
clear message; nothing is written in that case.

## Retrieving imported mutants

- List: `/api/mutants?project=owner/repo&batch=<id>`; the project mutant page accepts the same
  `batch` parameter.
- Exports: the `source` column carries the tool name and version, `importBatch` the batch id.
