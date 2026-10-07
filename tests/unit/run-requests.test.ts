import { describe, expect, it } from "vitest";
import { canManageRunRequest, type Principal } from "@/domain/auth/permissions";
import {
  reportSummary,
  runRequestNotificationTitle,
  runRequestRecipients,
  type RunRequestEvent,
  type RunRequestParticipants,
} from "@/domain/run-requests/notifications";
import {
  checkRunCounts,
  displayStatus,
  isLiveClaim,
  mutationScore,
  sameCommit,
  type ClaimState,
} from "@/domain/run-requests/status";
import { closeRunRequestSchema, reportRunSchema } from "@/lib/validation/schemas";

const NOW = new Date("2026-10-05T12:00:00Z");
const LATER = new Date("2026-10-06T12:00:00Z");
const EARLIER = new Date("2026-10-04T12:00:00Z");
const HEAD = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const NEW_HEAD = "ffffffffffffffffffffffffffffffffffffffff";

const claim = (over: Partial<ClaimState> = {}): ClaimState => ({
  status: "ACTIVE",
  expiresAt: LATER,
  commitSha: null,
  ...over,
});

describe("isLiveClaim", () => {
  it("counts active claims until they expire", () => {
    expect(isLiveClaim(claim(), NOW)).toBe(true);
    expect(isLiveClaim(claim({ expiresAt: EARLIER }), NOW)).toBe(false);
    expect(isLiveClaim(claim({ expiresAt: NOW }), NOW)).toBe(false);
  });

  it("never counts reported or abandoned claims", () => {
    expect(isLiveClaim(claim({ status: "REPORTED" }), NOW)).toBe(false);
    expect(isLiveClaim(claim({ status: "ABANDONED" }), NOW)).toBe(false);
  });
});

describe("sameCommit", () => {
  it("matches full and short SHAs case-insensitively", () => {
    expect(sameCommit(HEAD, HEAD)).toBe(true);
    expect(sameCommit(HEAD, "A1B2C3D")).toBe(true);
    expect(sameCommit("a1b2c3d", HEAD)).toBe(true);
    expect(sameCommit(HEAD, NEW_HEAD)).toBe(false);
    expect(sameCommit(null, HEAD)).toBe(false);
    expect(sameCommit(HEAD, "")).toBe(false);
  });
});

describe("displayStatus", () => {
  const base = { status: "OPEN" as const, headSha: HEAD, prHeadSha: HEAD, claims: [] };

  it("is open without claims", () => {
    expect(displayStatus(base, NOW)).toBe("OPEN");
  });

  it("is in progress with a live claim, open again once it expires", () => {
    expect(displayStatus({ ...base, claims: [claim()] }, NOW)).toBe("IN_PROGRESS");
    expect(displayStatus({ ...base, claims: [claim({ expiresAt: EARLIER })] }, NOW)).toBe("OPEN");
    expect(displayStatus({ ...base, claims: [claim({ status: "ABANDONED" })] }, NOW)).toBe("OPEN");
  });

  it("is reported once a run is reported, even with other runners still going", () => {
    const reported = claim({ status: "REPORTED", commitSha: HEAD });
    expect(displayStatus({ ...base, claims: [reported] }, NOW)).toBe("REPORTED");
    expect(displayStatus({ ...base, claims: [claim(), reported] }, NOW)).toBe("REPORTED");
  });

  it("is outdated when the PR head moved, unless a run was reported at the new head", () => {
    const moved = { ...base, prHeadSha: NEW_HEAD };
    expect(displayStatus(moved, NOW)).toBe("OUTDATED");
    expect(
      displayStatus({ ...moved, claims: [claim({ status: "REPORTED", commitSha: HEAD })] }, NOW),
    ).toBe("OUTDATED");
    expect(
      displayStatus(
        { ...moved, claims: [claim({ status: "REPORTED", commitSha: NEW_HEAD.slice(0, 8) })] },
        NOW,
      ),
    ).toBe("REPORTED");
  });

  it("lets the stored closed and cancelled states win", () => {
    const reported = [claim({ status: "REPORTED", commitSha: HEAD })];
    expect(displayStatus({ ...base, status: "CLOSED", claims: reported }, NOW)).toBe("CLOSED");
    expect(displayStatus({ ...base, status: "CANCELLED", prHeadSha: NEW_HEAD }, NOW)).toBe(
      "CANCELLED",
    );
  });
});

describe("checkRunCounts", () => {
  it("accepts runs where some mutants neither died nor survived", () => {
    expect(checkRunCounts({ generated: 10, killed: 6, survived: 2 })).toBeNull();
    expect(checkRunCounts({ generated: 10, killed: 7, survived: 3 })).toBeNull();
    expect(checkRunCounts({ generated: 0, killed: 0, survived: 0 })).toBeNull();
  });

  it("flags counts above the number generated", () => {
    expect(checkRunCounts({ generated: 5, killed: 6, survived: 0 })?.field).toBe("killed");
    expect(checkRunCounts({ generated: 5, killed: 0, survived: 6 })?.field).toBe("survived");
    expect(checkRunCounts({ generated: 5, killed: 3, survived: 3 })).toEqual({
      field: "survived",
      message: "Killed + survived cannot exceed mutants generated",
    });
  });
});

describe("mutationScore", () => {
  it("is killed over finished mutants", () => {
    expect(mutationScore({ killed: 3, survived: 1 })).toBe(0.75);
    expect(mutationScore({ killed: 0, survived: 4 })).toBe(0);
    expect(mutationScore({ killed: 0, survived: 0 })).toBeNull();
  });
});

describe("run request notifications", () => {
  const participants: RunRequestParticipants = {
    requesterId: "req",
    voterIds: ["voter", "req"],
    runnerIds: ["runner", "other-runner"],
    watcherIds: ["follower", "reviewer", "runner"],
    prAuthorId: "author",
  };
  const event = (type: RunRequestEvent["type"], actorId = "runner"): RunRequestEvent => ({
    type,
    actorId,
    actorUsername: "erin",
    prNumber: 15908,
    projectName: "curl",
  });

  it("announces a new request to project watchers and the PR author", () => {
    expect(runRequestRecipients(event("RUN_REQUESTED", "req"), participants).sort()).toEqual([
      "author",
      "follower",
      "reviewer",
      "runner",
    ]);
  });

  it("tells the requester and voters when someone claims it", () => {
    expect(runRequestRecipients(event("RUN_CLAIMED"), participants).sort()).toEqual([
      "req",
      "voter",
    ]);
  });

  it("sends reports to requester, voters, other runners and the PR author", () => {
    expect(runRequestRecipients(event("RUN_REPORTED"), participants).sort()).toEqual([
      "author",
      "other-runner",
      "req",
      "voter",
    ]);
  });

  it("skips a PR author without an account and never notifies the actor", () => {
    const recipients = runRequestRecipients(event("RUN_REPORTED", "req"), {
      ...participants,
      prAuthorId: null,
    });
    expect(recipients.sort()).toEqual(["other-runner", "runner", "voter"]);
  });

  it("titles mention the actor, the PR and the report summary", () => {
    expect(runRequestNotificationTitle(event("RUN_REQUESTED"))).toBe(
      "@erin requested a mutation testing run for PR #15908 in curl",
    );
    expect(runRequestNotificationTitle(event("RUN_CLAIMED"))).toBe(
      "@erin is running mutation testing on PR #15908",
    );
    expect(
      runRequestNotificationTitle({
        ...event("RUN_REPORTED"),
        actorUsername: null,
        detail: reportSummary({ generated: 12, killed: 9, survived: 3 }),
      }),
    ).toBe(
      "Someone reported a mutation testing run on PR #15908: 12 generated · 9 killed · 3 survived",
    );
  });
});

describe("canManageRunRequest", () => {
  const request = { projectId: "p1", requestedById: "req" };
  const user = (id: string, memberships: Principal["memberships"] = []): Principal => ({
    id,
    globalRole: "USER",
    memberships,
  });

  it("allows the requester, project reviewers and admins", () => {
    expect(canManageRunRequest(user("req"), request)).toBe(true);
    expect(canManageRunRequest(user("rev", [{ projectId: "p1", role: "REVIEWER" }]), request)).toBe(
      true,
    );
    expect(canManageRunRequest({ ...user("adm"), globalRole: "ADMIN" }, request)).toBe(true);
  });

  it("refuses everyone else", () => {
    expect(canManageRunRequest(null, request)).toBe(false);
    expect(canManageRunRequest(user("someone"), request)).toBe(false);
    expect(
      canManageRunRequest(user("rev", [{ projectId: "p2", role: "MAINTAINER" }]), request),
    ).toBe(false);
    expect(
      canManageRunRequest(user("c", [{ projectId: "p1", role: "CONTRIBUTOR" }]), request),
    ).toBe(false);
  });
});

describe("run request schemas", () => {
  const report = {
    requestId: "r1",
    commitSha: "A1B2C3D",
    toolName: "mull",
    generated: "12",
    killed: "9",
    survived: "3",
  };

  it("coerces form values and normalises the commit", () => {
    const parsed = reportRunSchema.parse({ ...report, durationSeconds: "", notes: "  " });
    expect(parsed).toMatchObject({
      commitSha: "a1b2c3d",
      generated: 12,
      killed: 9,
      survived: 3,
      durationSeconds: undefined,
      notes: undefined,
    });
  });

  it("rejects missing tools, bad commits and negative counts", () => {
    expect(reportRunSchema.safeParse({ ...report, toolName: " " }).success).toBe(false);
    expect(reportRunSchema.safeParse({ ...report, commitSha: "main" }).success).toBe(false);
    expect(reportRunSchema.safeParse({ ...report, survived: "-1" }).success).toBe(false);
  });

  it("only closes as closed or cancelled", () => {
    expect(closeRunRequestSchema.safeParse({ requestId: "r1", outcome: "CLOSED" }).success).toBe(
      true,
    );
    expect(closeRunRequestSchema.safeParse({ requestId: "r1", outcome: "OPEN" }).success).toBe(
      false,
    );
  });
});
