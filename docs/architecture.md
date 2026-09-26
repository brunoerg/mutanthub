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
two mutants). The same code pair at a different revision or line is reported as **similar**.
After changing the fingerprint material, run `npm run db:refingerprint` (the production `migrate`
service runs it on every deploy; it only touches stale rows). The drawer shows "Possible duplicate" while typing and after submission;
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
