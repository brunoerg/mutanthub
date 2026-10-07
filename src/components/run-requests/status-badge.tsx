import {
  RUN_REQUEST_STATUS_LABEL,
  type RunRequestDisplayStatus,
} from "@/domain/run-requests/status";
import { StatusPill } from "@/components/mutants/status-badge";

const TONE: Record<RunRequestDisplayStatus, "success" | "info" | "warning" | "muted" | "neutral"> =
  {
    OPEN: "success",
    IN_PROGRESS: "info",
    REPORTED: "neutral",
    OUTDATED: "warning",
    CLOSED: "muted",
    CANCELLED: "muted",
  };

export function RunRequestStatusBadge({ status }: { status: RunRequestDisplayStatus }) {
  return (
    <StatusPill tone={TONE[status]} data-testid="run-request-status" data-status={status}>
      {RUN_REQUEST_STATUS_LABEL[status]}
    </StatusPill>
  );
}
