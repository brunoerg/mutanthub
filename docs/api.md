The public read-only JSON API for dataset consumers.

# Public API

Read-only endpoints for dataset consumers (rate limit: 120 requests / minute / IP):

- `GET /api/mutants` – paginated list. Filters: `project=owner/repo`, `language`, `operator`,
  `reviewStatus`, `mutationStatus`, `contributor`, `commit`, `file`, `q`, `superseded`, `page`,
  `pageSize`. `superseded=hide` keeps only the latest result per mutation (drops a mutant when the
  same mutation has a newer result at a later commit); `superseded=only` lists the dropped ones.
- `GET /api/mutants/:id` – full record with diff, test evidence, validations and history.
- `GET /api/docs` – OpenAPI 3.1 description of the above.
- `GET /api/mutants/:id/patch` – the stored unified diff as a `text/x-patch` download.
- `GET /api/export/mutants.json` and `GET /api/export/mutants.csv` – streamed bulk exports with
  the same filters (plus `batch`, `drift`, `since`, `until`) and `limit` (default 10,000, max 50,000). See [Dataset](dataset.md).
- `GET /api/datasets/:slug/mutants.json` and `mutants.csv` – frozen, hashed snapshots published by admins.

```json
{
  "id": 182,
  "repository": "bitcoin/bitcoin",
  "commit": "9b2e4d6f8a0c1e3b5d7f9a1c3e5b7d9f1a3c5e7b",
  "file": "src/script/interpreter.cpp",
  "startLine": 60,
  "endLine": 60,
  "reviewStatus": "APPROVED",
  "mutationStatus": "SURVIVED",
  "reproductions": 4,
  "reproductionSummary": {
    "survived": 4,
    "killed": 0,
    "couldNotReproduce": 0,
    "consensus": "SURVIVED"
  }
}
```

The serializers in `src/server/api/serializers.ts` define the stable dataset shape; CSV/JSON
bulk exports can be added on top of them.
