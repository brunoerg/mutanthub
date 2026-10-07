# Security notes

This document records the security posture of MutantHub after the pre-release security pass
(September 2026): what is enforced, where, and what a deployer still has to do.

## Overview

- Commands, patches and logs are stored and displayed as text. Nothing is executed.
- Markdown is rendered with `marked` and sanitized with `sanitize-html` (no scripts, no event
- Every mutation goes through a service that checks the session and the role
- Server Actions include Next.js' built-in origin checks (CSRF protection); Auth.js protects its
- `src/proxy.ts` sets a nonce-based Content Security Policy (scripts use `'strict-dynamic'`;
- Privileged actions (membership, project activation, reviews and classifications) are written
- Post-login redirects accept same-origin paths only.
- Zod validates all inputs with size limits (`src/lib/validation/limits.ts`).
- A rate limiter protects submissions, validations, comments, reviews, project registration and
- File paths are validated against traversal; the mock client refuses paths outside its fixtures.

## Principles

- **Nothing user-supplied is executed.** Build, test and fuzz commands, patches, logs and
  diffs are stored and rendered as text. There is no runner, no shell, no `git apply`.
- **Authorization lives in services, not pages.** Every Server Action resolves the session,
  then calls a service that checks the role before touching data. Pages hide controls for
  convenience only.
- **State transitions are append-only.** Review and outcome changes, submission edits,
  membership and project changes are all recorded (`MutantStatusHistory`, `Activity`,
  `AuditLog`).

## Permission matrix

| Action                                         | Requirement (checked in)                                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browse projects, code, mutants, profiles, API  | none (public read)                                                                                                                                                                             |
| Register a project                             | global admin by default; any signed-in user with `PROJECT_REGISTRATION=users`                                                                                                                  |
| Follow / unfollow                              | signed in (`projectService.setFollowing`)                                                                                                                                                      |
| Submit a mutant                                | signed in, project active (`mutantService.submitMutant`)                                                                                                                                       |
| Edit / resubmit / withdraw a submission        | submitter or admin, allowed review state (`mutantService.*`)                                                                                                                                   |
| Record a reproduction, comment                 | signed in (`interactionService.*`)                                                                                                                                                             |
| Approve / reject / needs info / duplicate      | project reviewer, maintainer or admin (`reviewService.review`)                                                                                                                                 |
| Classify outcome (killed, equivalent, invalid) | same (`reviewService.changeMutationStatus`)                                                                                                                                                    |
| Manage members, activate/deactivate, refresh   | project maintainer or admin (`projectService.*`)                                                                                                                                               |
| Remove / demote the last maintainer            | refused (`assertNotLastMaintainer`)                                                                                                                                                            |
| Notifications                                  | owner only (`notificationService.*`, `findOwned`)                                                                                                                                              |
| Track / resync a pull request                  | signed in, project active (`pullRequestService.track`)                                                                                                                                         |
| Report / re-check a killing-test claim         | signed in (`killClaimService.create` / `refresh`)                                                                                                                                              |
| Request a run, vote, claim, report a run       | signed in, project active (`runRequestService.*`); at most 10 open requests per user                                                                                                           |
| Close, cancel or retarget a run request        | the requester, or a project reviewer, maintainer or admin (`canManageRunRequest`)                                                                                                              |
| Verify or refute a claim                       | project reviewer, maintainer or admin (`killClaimService.resolve`)                                                                                                                             |
| Bulk import of tool output                     | global admin only, same-origin upload (`importService.dryRun` / `commit`)                                                                                                                      |
| Drift check against the default branch         | project maintainer or admin (`driftService.checkAsMaintainer`), or the `CRON_SECRET` bearer on `/api/jobs/drift`                                                                               |
| Check runs on GitHub                           | posted only by the app installation token; never blocking                                                                                                                                      |
| Mocked sign-in                                 | only when `AUTH_MOCK` is enabled outside production                                                                                                                                            |
| GitHub reads for a signed-in user              | their own OAuth token from the encrypted JWT; never stored in the database, never sent to the browser, never used for background jobs; falls back to server credentials when GitHub rejects it |

Rules are pure functions in `src/domain/auth/permissions.ts` and are unit-tested in
`tests/unit/permissions.test.ts`. Ownership and state rules for submissions are tested in
`tests/unit/status.test.ts`.

## Input handling

- Every mutating entry point validates with Zod (`src/lib/validation/schemas.ts`) with size
  limits from `src/lib/validation/limits.ts`; file paths reject traversal and absolute paths.
- Markdown is rendered with `marked` and sanitized with `sanitize-html` (allow-list of tags and
  attributes, `http`/`https`/`mailto` schemes only, `rel="nofollow noopener noreferrer"` on
  links). Payload tests: `tests/unit/markdown-hardening.test.ts`.
- Post-login redirects accept same-origin paths only (`src/lib/safe-redirect.ts`).
- Rate limits (`src/server/infra/rate-limit.ts`): submissions, edits, reproductions, comments,
  reviews, run requests (requests, claims, reports), project registration, duplicate preview,
  mocked sign-in, and the public API. Redis
  makes them shared between instances; without Redis they are per process.

## Transport and browser hardening

`src/proxy.ts` adds headers to every HTML response:

- `Content-Security-Policy` with a per-request nonce and `'strict-dynamic'` for scripts. Monaco
  is loaded from jsDelivr by a trusted script and runs its workers from `blob:`; styles allow
  `'unsafe-inline'` because Monaco and React inject inline styles. `frame-ancestors 'none'`,
  `object-src 'none'`, `base-uri 'self'`, `form-action 'self' https://github.com` (OAuth
  redirect after the sign-in form). `upgrade-insecure-requests` in production.
- `Strict-Transport-Security` (production), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Cross-Origin-Opener-Policy: same-origin`, a restrictive `Permissions-Policy`, and no
  `X-Powered-By`.
- Server Actions carry Next.js' built-in origin check; Auth.js protects its own routes with
  CSRF tokens and signed, `HttpOnly` session cookies.

## Audit trail

`AuditLog` records who did what to which project, member or mutant, with structured metadata
(previous and new role or status, usernames). Maintainers see the last entries on the project
settings page. Entries are never deleted by the application.

## Secrets and configuration

- `AUTH_SECRET` signs sessions; rotate it to invalidate every session.
- `GITHUB_TOKEN` only needs public repository read access. OAuth scopes are `read:user user:email`.
  The GitHub App needs Contents, Metadata and Pull requests (read) plus Checks (write).
- `AUTH_MOCK=true` is refused in production unless `AUTH_MOCK_ALLOW_PRODUCTION=true` is set
  explicitly (staging demos only).
- The health endpoint reports component status only, never configuration values.

## Deployer checklist

1. Terminate TLS in front of the app and forward `X-Forwarded-For` (used for rate limits).
2. Set `AUTH_URL` to the public origin.
3. Provide `REDIS_URL` when running more than one instance.
4. Keep `AUTH_MOCK` unset or `false`.
5. Back up PostgreSQL; the audit trail and history live there.

## Known limitations

- CSP allows inline styles; a nonce-based style policy would require self-hosting Monaco and
  refactoring inline `style` attributes.
- Rate limits are per user id or client address; a shared NAT shares the anonymous budget.
- There is no account lockout because there are no passwords; GitHub handles authentication.
- No automated dependency scanning is configured yet (Dependabot or `npm audit` in CI).
