What is implemented and what is planned.

# Status

## Implemented (MVP)

- GitHub OAuth sign-in (read-only scopes) with a mocked login for development and tests.
- Project registration from GitHub metadata; per-project roles (contributor, reviewer, maintainer)
  and a global admin role; follow/unfollow.
- Maintainer settings page: add members by GitHub username (placeholder accounts are claimed on
  first sign-in), change roles, remove members (the last maintainer is protected), refresh
  metadata from GitHub, deactivate/reactivate the project.
- Repository browsing at any commit or branch: lazy file tree, read-only Monaco viewer with mutant
  indicators in the gutter, line selection via clicks or `#L123` links, commit selector, drift
  notice for older revisions, mobile drawers.
- Suggest-mutant drawer with pre-filled location, operator catalogue, diff generation, Monaco diff
  preview, test-evidence fields, live "possible duplicate" detection and inline validation errors.
- Mutant detail page: side-by-side and unified diff (copy patch), evidence, reproduction summary,
  validation timeline, Markdown discussion, full status history, duplicate and drift notices.
- Review queue with filters, inbox/detail layout, approve / reject / needs information / mark
  duplicate, and classification of the scientific outcome (survived, killed, equivalent, invalid).
- Submission lifecycle for contributors: edit while pending or awaiting information (previous
  evidence kept as revisions), resubmit after "needs information" or withdrawal, withdraw a
  pending submission (`WITHDRAWN` review status). Every step lands in the history.
- Reproductions (validations) with an optional killing-test reference (test path, PR or commit
  URL), and comments by any signed-in user.
- Pull request scope: track a pull request by number (or automatically through the GitHub App
  webhook), record its head commits as revisions, browse changed files in pull request mode with
  changed lines highlighted, submit mutants scoped to the pull request (only on lines the pull
  request changed, enforced server-side), and publish a
  non-blocking "MutantHub" check run on GitHub summarising the mutants on the changed lines.
  The pull request page filters its mutants by outcome, review status and file (the stat tiles
  and per-file counts are shortcuts). Both the page and the check run count each mutation once,
  with its latest result: mutants superseded by a newer push are hidden unless asked for, and an
  import at a pull request head refreshes its check run.
- Run requests: ask for someone to run mutation testing on an open pull request (from the PR page
  or the project's `/requests` board), optionally scoped to some changed files. Followers and
  reviewers are notified; runners claim it ("I'm running this", 48-hour hold), report the tool,
  commit and generated / killed / survived counts (also when nothing survived), and submit the
  survivors as usual. Requests show as outdated when the PR moves on (the requester can retarget),
  list which files in scope still have no mutants, and close automatically when the PR is merged
  or closed.
- In-app notifications: submitters and everyone who commented or reproduced a mutant hear about
  review decisions, reproductions, classifications and comments; reviewers hear about new,
  edited and resubmitted submissions. Header bell with unread count, `/notifications` inbox,
  mark-as-read. Written in the same transaction as the activity feed.
- Project overview with statistics, most affected files, top contributors, recent activity.
- Global mutant list with filters, per-project list, dashboard, public profiles, global search,
  activity feed, settings page.
- Public read-only JSON API with OpenAPI description; rate limiting; sanitized Markdown; size limits.
- Killing-test claims: "PR #123 / commit / test path kills this mutant" as a structured claim,
  checked against GitHub (pull request state, merge commit, whether the original code still
  exists there), verified by two reproductions at that commit or a reviewer verdict, reported
  in the pull request check run, and reflected in the mutant's outcome and history.
- Dataset exports: streamed JSON and CSV over the list filters, per-mutant patch download, and
  frozen, hashed, citable snapshots published by administrators from the Dataset page.
- Bulk import: maintainers and administrators upload the output of a mutation testing tool (JSON or JSON Lines);
  every row is validated against the repository at its commit and against the catalogue for
  duplicates in a dry run, then imported as approved mutants with the tool recorded as source.
- Drift checks: every open mutant is looked up at the project's current default branch and
  flagged as applies, moved (with the new line) or gone; maintainers run it from the settings
  page and a `CRON_SECRET`-protected job endpoint runs it on a schedule. Lists filter on it,
  exports carry it, and submitters are notified once when their code disappears, with a pointer
  to killing-test claims.
- Per-user GitHub quota: repository reads made while signed in use the user's own OAuth token
  (kept in the encrypted session, never stored), with the app installation token, the server
  token and anonymous access as fallbacks. Revoked tokens fall back automatically.
- Seed data, unit/API tests, end-to-end workflow tests.

## Not yet implemented

- DOI minting for snapshots (for example through Zenodo).
- Editing/deleting comments from the UI (the service layer already supports comment edits).
- Automatic rebasing of mutants to newer commits.
- Isolated execution runners (Docker) for automatic reproduction and machine verification of
  killing-test claims.
- GitHub App integration, pull-request links, CLI tooling.
- LLM-assisted analysis and automated equivalent-mutant detection.
- Email delivery for notifications, subscriptions to projects, gamification beyond the profile
  counters.
