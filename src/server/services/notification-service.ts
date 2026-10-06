import "server-only";
import type { Principal } from "@/domain/auth/permissions";
import { forbidden, notFound } from "@/lib/errors";
import { routes } from "@/lib/routes";
import {
  notificationRepository,
  type NotificationItem,
} from "@/server/repositories/notification-repository";

export const NOTIFICATION_PAGE_SIZE = 25;

export const notificationService = {
  /** Unread count + latest items for the header bell. */
  async getSummary(principal: Principal | null) {
    if (!principal) return { unread: 0, latest: [] as NotificationItem[] };
    const [unread, latest] = await Promise.all([
      notificationRepository.count(principal.id, { unreadOnly: true }),
      notificationRepository.list(principal.id, { take: 8 }),
    ]);
    return { unread, latest };
  },

  async listPage(principal: Principal | null, page: number, unreadOnly: boolean) {
    if (!principal) throw forbidden("Sign in to see notifications");
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    const [items, total, unread] = await Promise.all([
      notificationRepository.list(principal.id, {
        unreadOnly,
        take: NOTIFICATION_PAGE_SIZE,
        skip: (safePage - 1) * NOTIFICATION_PAGE_SIZE,
      }),
      notificationRepository.count(principal.id, { unreadOnly }),
      notificationRepository.count(principal.id, { unreadOnly: true }),
    ]);
    return { items, total, unread, page: safePage, pageSize: NOTIFICATION_PAGE_SIZE };
  },

  /** Marks one notification read and returns where it should navigate. */
  async open(principal: Principal | null, id: string): Promise<string> {
    if (!principal) throw forbidden("Sign in to continue");
    const item = await notificationRepository.findOwned(id, principal.id);
    if (!item) throw notFound("Notification");
    await notificationRepository.markRead(principal.id, [id]);
    return notificationTarget(item);
  },

  async markRead(principal: Principal | null, ids: string[]) {
    if (!principal) throw forbidden("Sign in to continue");
    const result = await notificationRepository.markRead(principal.id, ids);
    return result.count;
  },

  async markAllRead(principal: Principal | null) {
    if (!principal) throw forbidden("Sign in to continue");
    const result = await notificationRepository.markAllRead(principal.id);
    return result.count;
  },
};

/** Where a notification leads: the mutant (or the review panel for reviewer events). */
export function notificationTarget(
  item: Pick<NotificationItem, "type" | "mutant" | "project" | "runRequestId">,
): string {
  if (item.runRequestId && item.project)
    return routes.projectRunRequest(
      item.project.githubOwner,
      item.project.githubRepository,
      item.runRequestId,
    );
  if (item.mutant) {
    const reviewerEvent =
      item.type === "MUTANT_SUBMITTED" ||
      item.type === "MUTANT_RESUBMITTED" ||
      item.type === "MUTANT_EDITED";
    return reviewerEvent ? routes.reviewItem(item.mutant.id) : routes.mutant(item.mutant.id);
  }
  if (item.project) {
    if (item.type === "MUTANTS_IMPORTED")
      return routes.projectMutants(item.project.githubOwner, item.project.githubRepository);
    return routes.project(item.project.githubOwner, item.project.githubRepository);
  }
  return routes.dashboard();
}
