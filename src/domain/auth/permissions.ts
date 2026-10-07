import type { GlobalRole, ProjectRole } from "@/generated/prisma/enums";

/** Minimal identity used by authorization rules. Built from the session + memberships. */
export interface Principal {
  id: string;
  globalRole: GlobalRole;
  memberships: ReadonlyArray<{ projectId: string; role: ProjectRole }>;
}

export function isAdmin(p: Principal | null | undefined): boolean {
  return p?.globalRole === "ADMIN";
}

export function projectRole(
  p: Principal | null | undefined,
  projectId: string,
): ProjectRole | null {
  if (!p) return null;
  return p.memberships.find((m) => m.projectId === projectId)?.role ?? null;
}

/** Reviewers, maintainers and admins may moderate mutants of a project. */
export function canReviewProject(p: Principal | null | undefined, projectId: string): boolean {
  if (!p) return false;
  if (isAdmin(p)) return true;
  const role = projectRole(p, projectId);
  return role === "REVIEWER" || role === "MAINTAINER";
}

/** True when the principal can moderate at least one project (shows /review in the nav). */
export function canAccessReviewQueue(p: Principal | null | undefined): boolean {
  if (!p) return false;
  if (isAdmin(p)) return true;
  return p.memberships.some((m) => m.role === "REVIEWER" || m.role === "MAINTAINER");
}

/** Project ids the principal can review; `null` means "all projects" (admin). */
export function reviewableProjectIds(p: Principal | null | undefined): string[] | null {
  if (!p) return [];
  if (isAdmin(p)) return null;
  return p.memberships
    .filter((m) => m.role === "REVIEWER" || m.role === "MAINTAINER")
    .map((m) => m.projectId);
}

export function canManageProject(p: Principal | null | undefined, projectId: string): boolean {
  if (!p) return false;
  if (isAdmin(p)) return true;
  return projectRole(p, projectId) === "MAINTAINER";
}

/** Who may register new projects: only global admins, or any signed-in user. */
export type ProjectRegistrationPolicy = "admins" | "users";

export function canRegisterProject(
  p: Principal | null | undefined,
  policy: ProjectRegistrationPolicy = "admins",
): boolean {
  if (!p) return false;
  return policy === "users" ? true : isAdmin(p);
}

export function canSubmitMutant(p: Principal | null | undefined): boolean {
  return Boolean(p);
}

export function canValidateMutant(p: Principal | null | undefined): boolean {
  return Boolean(p);
}

export function canComment(p: Principal | null | undefined): boolean {
  return Boolean(p);
}

export function canEditComment(
  p: Principal | null | undefined,
  comment: { userId: string },
  projectId: string,
): boolean {
  if (!p) return false;
  return p.id === comment.userId || canReviewProject(p, projectId);
}

/** Submitters own their mutants; admins may act on behalf of anyone. */
export function isMutantOwner(
  p: Principal | null | undefined,
  mutant: { createdById: string },
): boolean {
  if (!p) return false;
  return p.id === mutant.createdById || isAdmin(p);
}

/**
 * The title and description are free-form prose, so their owner may update
 * them at any review status (full submission edits are limited to pending mutants).
 */
export function canEditMutantText(
  p: Principal | null | undefined,
  mutant: { createdById: string },
): boolean {
  return isMutantOwner(p, mutant);
}

/** Only reviewers of the project can change the scientific status directly. */
export function canChangeMutationStatus(
  p: Principal | null | undefined,
  projectId: string,
): boolean {
  return canReviewProject(p, projectId);
}

/** The requester and the project's reviewers may close, cancel or retarget a run request. */
export function canManageRunRequest(
  p: Principal | null | undefined,
  request: { projectId: string; requestedById: string },
): boolean {
  if (!p) return false;
  return p.id === request.requestedById || canReviewProject(p, request.projectId);
}
