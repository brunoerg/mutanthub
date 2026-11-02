How to obtain MutantHub data as a dataset: live exports, frozen snapshots, the row schema, and how to cite it.

# Dataset

MutantHub exists to produce a public dataset of mutants that survived real test suites, together
with the evidence and the community's reproductions. This page is written for researchers.

## Two ways to get the data

| Method          | URL                                                                     | Changes over time | Use for                      |
| --------------- | ----------------------------------------------------------------------- | ----------------- | ---------------------------- |
| **Live export** | `/api/export/mutants.json`, `/api/export/mutants.csv`                   | yes               | exploration, dashboards      |
| **Snapshot**    | `/api/datasets/<slug>/mutants.json`, `/api/datasets/<slug>/mutants.csv` | never             | papers, replication packages |

Live exports stream straight from the database and accept the same filters as the list API:
`project=owner/repo`, `language`, `operator`, `reviewStatus`, `mutationStatus`, `contributor`,
`commit`, `file`, `q`, `batch`, `drift`, `superseded`, `since`, `until` (`YYYY-MM-DD`, inclusive),
plus `limit` (default 10,000, maximum 50,000). Example:

```bash
curl -sL "https://mutanthub.example.com/api/export/mutants.csv?project=curl/curl&reviewStatus=APPROVED" -o curl-mutants.csv
```

To get the surviving mutants of one project that still apply to its default branch, with diffs
(e.g. to feed to an LLM that writes tests for them):

```bash
curl -sL "https://mutanthub.example.com/api/export/mutants.json?project=libbitcoin/libbitcoin-system&mutationStatus=SURVIVED&drift=APPLIES&superseded=hide" -o survivors.json
```

The **Export JSON** button on a project's Mutants page downloads the same export for the filters
currently applied there.

Snapshots are published by administrators from the **Dataset** page. Their rows are stored as
published, so later status changes never alter them, and each one carries a SHA-256 hash of the
canonical rows. Every snapshot has a permanent page (`/datasets/<slug>`) with a citation block.
Downloads send the hash in the `X-Dataset-Sha256` header and are cacheable forever.

## Row schema

JSON exports are an array of objects; CSV exports have one header row and RFC 4180 quoting
(multi-line diffs and commands are quoted, quotes are doubled). Columns, in order:

| Column                                                                                   | Meaning                                                                                                                                   |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                                     | Mutant id; `url` links to its page                                                                                                        |
| `repository`, `language`                                                                 | GitHub repository and primary language                                                                                                    |
| `commit`                                                                                 | Exact commit the mutant was recorded against; line numbers refer to it                                                                    |
| `pullRequest`                                                                            | Pull request number when the mutant was scoped to one, else empty                                                                         |
| `file`, `startLine`, `endLine`                                                           | Location in that commit                                                                                                                   |
| `title`, `description`                                                                   | Contributor's summary and optional notes (Markdown)                                                                                       |
| `mutationOperator`                                                                       | One of the operator categories (relational, arithmetic, constant, ...)                                                                    |
| `originalCode`, `mutatedCode`, `diff`                                                    | The change; `diff` is a unified patch                                                                                                     |
| `reviewStatus`                                                                           | Moderation: `PENDING`, `NEEDS_INFORMATION`, `APPROVED`, `REJECTED`, `DUPLICATE`, `WITHDRAWN`                                              |
| `mutationStatus`                                                                         | Outcome: `UNKNOWN`, `SURVIVED`, `KILLED`, `EQUIVALENT`, `INVALID`                                                                         |
| `observedResult`                                                                         | What the submitter observed (`SURVIVED`, `KILLED`, `UNKNOWN`)                                                                             |
| `buildCommand`, `testCommand`, `fuzzCommand`, `environment`                              | Latest submission evidence, verbatim text; never executed by MutantHub                                                                    |
| `reproductions`, `reproducedSurvived`, `reproducedKilled`, `reproducedCouldNotReproduce` | Reproduction attempts by other contributors                                                                                               |
| `killingTestRefs`                                                                        | Test paths, PRs or commits reported to kill the mutant, `                                                                                 | `-separated |
| `contributor`                                                                            | GitHub login of the submitter                                                                                                             |
| `createdAt`, `updatedAt`                                                                 | ISO 8601 timestamps                                                                                                                       |
| `killClaims`                                                                             | Structured killing-test claims, e.g. `PR #123 (VERIFIED) \| commit abc1234 (CLAIMED)`; statuses `CLAIMED`, `VERIFIED`, `REFUTED`, `STALE` |
| `source`                                                                                 | `manual` for hand-written mutants, otherwise the importing tool and version (see [Importing mutants](import.md))                          |
| `importBatch`                                                                            | Import batch id for bulk-imported mutants, empty otherwise                                                                                |

New columns are only ever appended. Cells starting with `=` or `@` are prefixed with a quote to
defuse spreadsheet formulas; cells starting with `+` or `-` (diffs, code) are left intact, so
open CSV files as text in spreadsheet software.

## Reading the data correctly

- `mutationStatus = SURVIVED` means the recorded tests did not detect the mutant. It is not a
  verdict on the test suite: the mutant may be **equivalent**, environment-dependent, or simply
  not reproduced yet. Prefer rows with `reviewStatus = APPROVED` and at least one reproduction.
- `reviewStatus` and `mutationStatus` are independent. A mutant can be approved and killed.
- Conflicting reproductions show up as both `reproducedSurvived` and `reproducedKilled` being
  non-zero; the platform deliberately does not pick a winner.
- Per-mutant patches are available at `/api/mutants/<id>/patch` for reproduction.
- A `VERIFIED` kill claim means two independent reproductions killed the mutant at the claim's
  commit (or a reviewer confirmed it); the mutant's `mutationStatus` becomes `KILLED` at that
  point, with the claim referenced in its history.
- A `VERIFIED` kill claim means two independent reproductions killed the mutant at the claim's
  commit (or a reviewer confirmed it); the mutant's `mutationStatus` becomes `KILLED` at that
  point, with the claim referenced in its history.

## Citing

Cite a snapshot, not the live export. The snapshot page gives you the permanent URL, the
publication date, the row count and the hash:

```
MutantHub dataset snapshot "Surviving mutants, September 2026" (2026-09-15), 1234 mutants.
https://mutanthub.example.com/datasets/surviving-mutants-september-2026-2026-09-15
SHA-256 3b1f...
```

DOI minting (for example through Zenodo) can be layered on top of the same snapshot record.
