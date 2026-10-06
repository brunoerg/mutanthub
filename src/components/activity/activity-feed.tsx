import Link from "next/link";
import { Activity as ActivityIcon } from "lucide-react";
import type { ActivityItem } from "@/server/repositories/interaction-repository";
import { routes } from "@/lib/routes";
import { relativeTime } from "@/lib/format";
import { EmptyState } from "@/components/shared/empty-state";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

function describe(item: ActivityItem): React.ReactNode {
  const actor = item.actor ? (
    <Link
      href={routes.user(item.actor.githubUsername)}
      className="font-mono text-xs font-medium hover:underline"
    >
      @{item.actor.githubUsername}
    </Link>
  ) : (
    <span className="font-medium">System</span>
  );
  const mutant = item.mutant ? (
    <Link href={routes.mutant(item.mutant.id)} className="font-mono text-xs hover:underline">
      #{item.mutant.id}
    </Link>
  ) : null;
  const payload = (item.payload ?? {}) as Record<string, unknown>;
  const runRequest =
    item.project && typeof payload.requestId === "string" ? (
      <Link
        href={routes.projectRunRequest(
          item.project.githubOwner,
          item.project.githubRepository,
          payload.requestId,
        )}
        className="font-mono text-xs hover:underline"
      >
        PR #{String(payload.number ?? "")}
      </Link>
    ) : (
      <span className="font-mono text-xs">PR #{String(payload.number ?? "")}</span>
    );

  switch (item.type) {
    case "MUTANT_SUBMITTED":
      return (
        <>
          {actor} submitted mutant {mutant}
        </>
      );
    case "MUTANT_APPROVED":
      return (
        <>
          {actor} approved mutant {mutant}
        </>
      );
    case "MUTANT_REJECTED":
      return (
        <>
          {actor} rejected mutant {mutant}
        </>
      );
    case "MUTANT_NEEDS_INFORMATION":
      return (
        <>
          {actor} requested more information on mutant {mutant}
        </>
      );
    case "MUTANT_MARKED_DUPLICATE":
      return (
        <>
          {actor} marked mutant {mutant} as duplicate
        </>
      );
    case "MUTANT_EDITED":
      return (
        <>
          {actor} edited the submission of mutant {mutant}
        </>
      );
    case "MUTANT_WITHDRAWN":
      return (
        <>
          {actor} withdrew mutant {mutant}
        </>
      );
    case "MUTANT_RESUBMITTED":
      return (
        <>
          {actor} resubmitted mutant {mutant} for review
        </>
      );
    case "MUTANT_REPRODUCED":
      return (
        <>
          {actor} reproduced mutant {mutant} as{" "}
          <span className="font-mono text-xs">
            {String(payload.result ?? "").replace(/_/g, " ")}
          </span>
        </>
      );
    case "MUTANT_KILLED":
      return (
        <>
          {actor} killed mutant {mutant}
        </>
      );
    case "MUTANT_MARKED_EQUIVALENT":
      return (
        <>
          Mutant {mutant} was classified as EQUIVALENT by {actor}
        </>
      );
    case "MUTANT_MARKED_INVALID":
      return (
        <>
          Mutant {mutant} was classified as INVALID by {actor}
        </>
      );
    case "MUTANT_STATUS_CHANGED":
      return (
        <>
          {actor} changed mutant {mutant} from{" "}
          <span className="font-mono text-xs">{String(payload.from ?? "")}</span> to{" "}
          <span className="font-mono text-xs">{String(payload.to ?? "")}</span>
        </>
      );
    case "KILL_CLAIMED":
      return (
        <>
          {actor} reported a killing test for mutant {mutant}
        </>
      );
    case "KILL_VERIFIED":
      return <>A killing test for mutant {mutant} was verified</>;
    case "KILL_REFUTED":
      return <>A killing-test claim for mutant {mutant} was refuted</>;
    case "MUTANT_DRIFTED":
      return (
        <>
          The original code of mutant {mutant} is no longer on the default branch
          {payload.head ? (
            <>
              {" "}
              (<span className="font-mono text-xs">{String(payload.head).slice(0, 7)}</span>)
            </>
          ) : null}
        </>
      );
    case "MUTANTS_IMPORTED":
      return (
        <>
          {actor} imported {String(payload.created ?? "")} mutants from{" "}
          <span className="font-mono text-xs">{String(payload.tool ?? "a tool")}</span>
        </>
      );
    case "RUN_REQUESTED":
      return (
        <>
          {actor} requested a mutation testing run for {runRequest}
        </>
      );
    case "RUN_CLAIMED":
      return (
        <>
          {actor} is running mutation testing on {runRequest}
        </>
      );
    case "RUN_REPORTED":
      return (
        <>
          {actor} reported a mutation testing run on {runRequest}
          {payload.detail ? (
            <span className="text-muted-foreground"> · {String(payload.detail)}</span>
          ) : null}
        </>
      );
    case "COMMENT_ADDED":
      return (
        <>
          {actor} commented on mutant {mutant}
        </>
      );
    default:
      return <>{actor} did something</>;
  }
}

export function ActivityFeed({
  items,
  emptyTitle = "No activity yet",
}: {
  items: ActivityItem[];
  emptyTitle?: string;
}) {
  if (items.length === 0) return <EmptyState icon={ActivityIcon} title={emptyTitle} compact />;
  return (
    <ol className="divide-border divide-y" data-testid="activity-feed">
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-2.5 py-2 text-sm">
          <Avatar className="mt-0.5 size-5">
            <AvatarImage src={item.actor?.avatarUrl ?? undefined} alt="" />
            <AvatarFallback className="text-[9px]">
              {item.actor?.githubUsername.slice(0, 2).toUpperCase() ?? "SY"}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="leading-snug">{describe(item)}</div>
            <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 text-xs">
              {item.project ? (
                <Link
                  href={routes.project(item.project.githubOwner, item.project.githubRepository)}
                  className="font-mono hover:underline"
                >
                  {item.project.githubOwner}/{item.project.githubRepository}
                </Link>
              ) : null}
              {item.mutant ? (
                <span className="truncate font-mono">
                  {item.mutant.filePath}:{item.mutant.startLine}
                </span>
              ) : null}
              <time dateTime={item.createdAt.toISOString()}>{relativeTime(item.createdAt)}</time>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
