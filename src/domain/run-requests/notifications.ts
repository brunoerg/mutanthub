/**
 * Recipient rules for run-request events. Pure, like
 * src/domain/notifications/build.ts, which handles mutant events.
 */

export type RunRequestEventType = "RUN_REQUESTED" | "RUN_CLAIMED" | "RUN_REPORTED";

export interface RunRequestEvent {
  type: RunRequestEventType;
  actorId: string;
  actorUsername: string | null;
  prNumber: number;
  projectName: string;
  /** Report summary ("12 generated · 3 survived"). */
  detail?: string | null;
}

export interface RunRequestParticipants {
  requesterId: string;
  voterIds: string[];
  /** Users who claimed or reported on the request. */
  runnerIds: string[];
  /** Project followers, reviewers and maintainers. */
  watcherIds: string[];
  /** MutantHub account of the PR author, when they have one. */
  prAuthorId: string | null;
}

/**
 * A new request goes to the people watching the project (potential runners).
 * A claim tells the requester and the voters that someone is on it. A report
 * goes to them, to the other runners and to the PR author, who can act on
 * surviving mutants. The actor never notifies themself.
 */
export function runRequestRecipients(event: RunRequestEvent, p: RunRequestParticipants): string[] {
  let ids: Array<string | null>;
  switch (event.type) {
    case "RUN_REQUESTED":
      ids = [...p.watcherIds, p.prAuthorId];
      break;
    case "RUN_CLAIMED":
      ids = [p.requesterId, ...p.voterIds];
      break;
    case "RUN_REPORTED":
      ids = [p.requesterId, ...p.voterIds, ...p.runnerIds, p.prAuthorId];
      break;
  }
  return [...new Set(ids.filter((id): id is string => !!id))].filter((id) => id !== event.actorId);
}

export function runRequestNotificationTitle(event: RunRequestEvent): string {
  const actor = event.actorUsername ? `@${event.actorUsername}` : "Someone";
  const pr = `PR #${event.prNumber}`;
  switch (event.type) {
    case "RUN_REQUESTED":
      return `${actor} requested a mutation testing run for ${pr} in ${event.projectName}`;
    case "RUN_CLAIMED":
      return `${actor} is running mutation testing on ${pr}`;
    case "RUN_REPORTED":
      return `${actor} reported a mutation testing run on ${pr}${event.detail ? `: ${event.detail}` : ""}`;
  }
}

export function reportSummary(c: { generated: number; killed: number; survived: number }): string {
  return `${c.generated} generated · ${c.killed} killed · ${c.survived} survived`;
}
