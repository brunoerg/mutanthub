How the codebase is organised, the domain model, and the rules behind duplicate detection and commit drift.

# Architecture

## Stack

| Concern    | Choice                                                     |
| ---------- | ---------------------------------------------------------- |
| Framework  | Next.js 16 (App Router, Server Components, Server Actions) |
| Language   | TypeScript (strict), React 19                              |
| UI         | Tailwind CSS v4, shadcn/ui, Lucide icons, Monaco Editor    |
| Database   | PostgreSQL 17, Prisma 7 (`@prisma/adapter-pg`)             |
| Auth       | Auth.js (next-auth v5) with GitHub OAuth, JWT sessions     |
| GitHub     | REST API v3 through a small client with an in-memory cache |
| Validation | Zod                                                        |
| Tests      | Vitest (unit, API), Playwright (end-to-end)                |
| Tooling    | ESLint, Prettier                                           |

The project is a single Next.js application, but layered so that the backend could be split out
later. React components never call Prisma or GitHub directly.

```
src/
├── app/                      Routes (App Router). Pages are thin: they call services and render.
│   ├── api/                  Public REST API (/api/mutants, /api/mutants/[id], /api/docs) and
│   │                         internal JSON endpoints (file tree). Auth.js handler.
│   ├── projects/[owner]/[repo]/code/[[...path]]   IDE-like code browser
│   ├── mutants/, review/, dashboard/, users/, search/, settings/, signin/
├── components/
│   ├── ui/                   shadcn/ui primitives
│   ├── code/                 Monaco viewer/diff wrappers, static diff & command blocks
│   ├── code-browser/         file tree, mutants panel, workspace state
│   ├── mutants/              suggest-mutant drawer, badges, tables, filters
│   ├── mutant-detail/, review/, projects/, activity/, layout/, shared/
├── domain/                   Pure, framework-free logic (unit-tested)
│   ├── mutants/fingerprint.ts        duplicate detection hash
│   ├── mutants/diff.ts               unified diff helpers (generate / stats), never applied
│   ├── mutants/status.ts             review & mutation transitions, labels, activity mapping
│   ├── mutants/validation-summary.ts "Survived — confirmed by N contributors" logic
│   └── auth/permissions.ts           role checks (global + per-project)
├── lib/                      Zod schemas & limits, errors, rate limiting, markdown sanitizing,
│                             route builders, formatting helpers
├── server/                   Server-only code
│   ├── auth/                 Auth.js config (GitHub + mock credentials), session helpers
│   ├── db/prisma.ts          Prisma client singleton
│   ├── github/               GitHubClient interface, live REST client, fixture mock, TTL cache
│   ├── infra/                Redis connection, cache store and rate-limit store (memory or Redis)
│   ├── repositories/         All Prisma queries (users, projects, mutants, interactions, stats)
│   ├── services/             Use cases + authorization (project, code browser, mutant, review,
│   │                         interaction, dashboard, search, user)
│   ├── actions/              Server Actions: thin adapters from forms to services
│   └── api/                  REST serializers and HTTP helpers
└── generated/prisma/         Generated Prisma client (git-ignored)
prisma/                       schema.prisma, migrations, seed.ts
tests/                        unit/, api/ (Vitest) and e2e/ (Playwright)
```

Request flow: **page / action → service (authorization, validation, rules) → repository (Prisma)**
and **service → GitHubClient (live or mock) → cache**.

## Domain model

- **Project** – a GitHub repository (`owner/repo`, default branch, language). Members hold a
  per-project role: `CONTRIBUTOR`, `REVIEWER`, `MAINTAINER`. Users have a global role
  (`USER`, `ADMIN`).
- **Revision** – an exact commit (`projectId + commitSha` is unique). **Every mutant points to a
  Revision**; a line number identifies a location only together with its revision. A revision may
  be the head of a tracked pull request.
- **PullRequest** – a tracked GitHub pull request with its head/base commits and the changed line
  ranges of the head, so mutants can be scoped to it and summarised in a check run.
- **Mutant** – file, line range, original/mutated code, git diff, operator, title, description,
  `fingerprint`, and two independent states:
  - `reviewStatus`: `PENDING`, `NEEDS_INFORMATION`, `APPROVED`, `REJECTED`, `DUPLICATE`,
    `WITHDRAWN` (moderation; only the submitter withdraws or resubmits);
  - `mutationStatus`: `UNKNOWN`, `SURVIVED`, `KILLED`, `EQUIVALENT`, `INVALID` (experimental
    outcome). A mutant can be `APPROVED` + `SURVIVED` today and become `KILLED` later without
    losing its history.
- **Submission** – how the submitter tested the mutant (build/test/fuzz commands, duration,
  environment, OS, compiler, observed result, notes, logs). Only the test command and the
  observed result are required; the title is generated from the operator and location when
  left empty. Text only.
- **Validation** – a reproduction attempt by another user: `SURVIVED`, `KILLED`,
  `COULD_NOT_REPRODUCE`, plus command/environment/notes and an optional `killingTestRef`.
- **KillClaim** – a structured claim that a pull request, commit or test kills the mutant, with
  the checks MutantHub ran against GitHub (PR state, verification commit, whether the original
  code still applies) and its verification status. Reproductions can be attached to a claim.
- **RunRequest** – "could someone run mutation testing on PR #123?" Pinned to the PR head at
  request time, optionally scoped to some of its changed files, with notes for runners. Only
  `OPEN`, `CLOSED` and `CANCELLED` are stored; "in progress", "reported" and "outdated" (the PR
  moved past the requested commit) are derived at read time (`src/domain/run-requests/status.ts`),
  so nothing has to expire claims in the background. Open requests close when their PR is merged
  or closed. One open request per PR; others add a vote, which also subscribes them.
- **RunClaim** – a runner's "I'm running this" (expires after 48 hours unless extended) and,
  once done, their self-reported run: tool, commit, command, generated / killed / survived
  counts. A report with nothing surviving is still a result. Surviving mutants are submitted and
  reviewed as usual; a report never changes a mutant.
- **Comment** – Markdown discussion (sanitized on render).
- **MutantStatusHistory** – append-only log of every review/mutation transition and every
  submission edit (who, from, to, when, comment).
- **Activity** – feed events (submitted, approved, rejected, reproduced, killed, equivalent,
  comment added, ...).
- **Notification** – per-recipient inbox entry derived from an activity event (recipient rules
  live in `src/domain/notifications/build.ts`).

## Duplicate detection

`fingerprint = sha256(project, revision, file path, start line, normalized original code,
normalized mutated code)`; normalization removes indentation, trailing whitespace, CRLF and blank
lines. Submissions with the same fingerprint are **exact** duplicates. The start line is part of
the identity because files repeat statements (the same mutation of `drop();` in two functions is
two mutants). The same mutation at another commit is reported as **similar**: it shares the
persisted `similarityKey = sha256(project, file path, normalized original code, normalized mutated
code, the two nearest non-blank lines above and below)`. The line number is left out so the key
survives code moving between commits, and the surrounding lines keep a repeated statement apart
(deleting `return 0;` in two functions gives two keys). Mutants at the same commit are never
similar: there the line already tells them apart. The context is read from the file at the
mutant's commit (the import and the submission already fetch it); when the file cannot be read
the key is null and the mutant is linked to nothing. `similarityKeyVersion` records the scheme:
older version 1 keys (code pair only) are recomputed by `npm run db:similarity`, which the
production `migrate` service runs after `db:refingerprint`, and by `POST /api/jobs/similarity`
(both only touch older rows). This links repeated runs of a tool across commits: a mutant that
survived at commit X lists the one killed at a later commit Y (with its status) on its page, and
the import report lists rows that match a mutant at another commit. Statuses are never copied
between revisions. Instead, `Mutant.superseded` marks a mutant when its mutation has a newer
conclusive result (SURVIVED, KILLED or EQUIVALENT, not rejected, withdrawn or duplicate) at a later
commit (commit date, else first-seen date), or an EQUIVALENT result anywhere. The mutant list's
"Superseded: hide" filter therefore shows the latest result per mutation, so a survivor killed at
a later commit drops out while one that regressed (killed, then survived) stays. The flag is
recomputed for the affected similarity keys on every create, import, edit and status change
(`src/server/repositories/superseded.ts`), and for every row by `db:refingerprint`. After changing
the fingerprint material, run `npm run db:refingerprint` (the production `migrate` service runs it
on every deploy; it only touches stale rows). After changing the similarity key material, bump
`SIMILARITY_KEY_VERSION` so the backfill picks every row up. The drawer shows "Possible
duplicate" while typing (adding a substring match on the code, where an empty snippet only matches
another deletion) and after submission;
nothing is blocked automatically. Reviewers can mark a mutant as `DUPLICATE` of another.

## Commit drift

The code browser always shows which commit is being viewed. Mutant pages state
"Mutant created against commit abc1234" and, when the default branch has moved on, warn that the
mutant refers to an older revision. Automatic rebasing is intentionally left for a future
milestone; historical references are preserved as-is.

## Routes

| Route                                     | Description                                      |
| ----------------------------------------- | ------------------------------------------------ |
| `/`                                       | Landing page                                     |
| `/dashboard`                              | Personal dashboard (signed in)                   |
| `/projects`                               | Projects + register repository                   |
| `/projects/[owner]/[repo]`                | Project overview and statistics                  |
| `/projects/[owner]/[repo]/code/[...path]` | Code browser (`?ref=` selects a commit/branch)   |
| `/projects/[owner]/[repo]/mutants`        | Mutants of a project                             |
| `/mutants`                                | All mutants with filters                         |
| `/mutants/[id]`                           | Mutant detail, evidence, validations, discussion |
| `/review`                                 | Review queue (reviewers, maintainers, admins)    |
| `/users/[username]`                       | Public profile                                   |
| `/search`                                 | Global search (press `/`)                        |
| `/settings`                               | Account settings                                 |
| `/signin`                                 | Sign-in (GitHub or mocked)                       |
