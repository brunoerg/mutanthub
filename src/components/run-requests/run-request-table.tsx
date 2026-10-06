import Link from "next/link";
import { FlaskConical, ThumbsUp } from "lucide-react";
import type { RunRequestRow } from "@/server/services/run-request-service";
import { routes } from "@/lib/routes";
import { relativeTime, shortSha } from "@/lib/format";
import { EmptyState } from "@/components/shared/empty-state";
import { UserChip } from "@/components/shared/user-chip";
import { RunRequestStatusBadge } from "./status-badge";

interface RunRequestTableProps {
  owner: string;
  repo: string;
  requests: RunRequestRow[];
  emptyTitle?: string;
  emptyDescription?: string;
}

export function RunRequestTable({
  owner,
  repo,
  requests,
  emptyTitle = "No run requests",
  emptyDescription,
}: RunRequestTableProps) {
  if (requests.length === 0)
    return <EmptyState icon={FlaskConical} title={emptyTitle} description={emptyDescription} />;
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="w-full text-sm" data-testid="run-request-table">
        <thead className="bg-muted/50 text-muted-foreground text-left text-[11px] tracking-wide uppercase">
          <tr>
            <th className="px-3 py-2 font-medium">Pull request</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Requested by</th>
            <th className="px-3 py-2 font-medium">Runs</th>
            <th className="px-3 py-2 font-medium">
              <ThumbsUp className="size-3" aria-label="Votes" />
            </th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {requests.map((r) => (
            <tr key={r.id} className="hover:bg-muted/40" data-testid="run-request-row">
              <td className="max-w-[420px] px-3 py-2">
                <Link
                  href={routes.projectRunRequest(owner, repo, r.id)}
                  className="block truncate font-medium hover:underline"
                >
                  <span className="text-muted-foreground font-mono text-xs">
                    #{r.pullRequest.number}
                  </span>{" "}
                  {r.pullRequest.title}
                </Link>
                <span className="text-muted-foreground text-xs">
                  at <span className="font-mono">{shortSha(r.headSha)}</span>
                  {r.files.length
                    ? ` · ${r.files.length} file${r.files.length === 1 ? "" : "s"}`
                    : " · whole PR"}{" "}
                  · {relativeTime(r.createdAt)}
                </span>
              </td>
              <td className="px-3 py-2">
                <RunRequestStatusBadge status={r.displayStatus} />
              </td>
              <td className="px-3 py-2">
                <UserChip user={r.requestedBy} size="xs" />
              </td>
              <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                {r.reports} reported
                {r.liveClaims ? ` · ${r.liveClaims} running` : ""}
              </td>
              <td className="px-3 py-2 text-xs">{r._count.votes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
