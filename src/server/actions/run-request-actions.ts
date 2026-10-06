"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { runRequestService } from "@/server/services/run-request-service";
import { routes } from "@/lib/routes";
import { formToObject, runAction, type ActionResult } from "./result";

type Touched = {
  id: string;
  project: { githubOwner: string; githubRepository: string };
  pullRequest: { number: number };
};

function revalidateRequest(request: Touched) {
  const { githubOwner: owner, githubRepository: repo } = request.project;
  revalidatePath(routes.projectRunRequest(owner, repo, request.id));
  revalidatePath(routes.projectRunRequests(owner, repo));
  revalidatePath(routes.projectPull(owner, repo, request.pullRequest.number));
}

export async function createRunRequestAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const owner = String(formData.get("owner") ?? "");
  const repo = String(formData.get("repo") ?? "");
  const result = await runAction(async () => {
    const user = await getCurrentUser();
    const files = formData.getAll("files").filter((f): f is string => typeof f === "string");
    const created = await runRequestService.create(user, { ...formToObject(formData), files });
    revalidatePath(routes.projectRunRequests(owner, repo));
    revalidatePath(routes.projectPull(owner, repo, created.number));
    return { id: created.id };
  });
  if (result.ok && owner && repo) redirect(routes.projectRunRequest(owner, repo, result.data.id));
  return result;
}

/** One adapter for the small buttons on a request (vote, claim, abandon, retarget). */
export async function runRequestStepAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const user = await getCurrentUser();
    const input = formToObject(formData);
    let request: Touched;
    switch (input.step) {
      case "vote":
        request = await runRequestService.setVote(user, input, true);
        break;
      case "unvote":
        request = await runRequestService.setVote(user, input, false);
        break;
      case "claim":
        request = await runRequestService.claim(user, input);
        break;
      case "abandon":
        request = await runRequestService.abandon(user, input);
        break;
      case "retarget":
        request = await runRequestService.retarget(user, input);
        break;
      default:
        throw new Error(`Unknown step ${input.step}`);
    }
    revalidateRequest(request);
    return undefined;
  });
}

export async function reportRunAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const user = await getCurrentUser();
    revalidateRequest(await runRequestService.report(user, formToObject(formData)));
    return undefined;
  });
}

export async function closeRunRequestAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const user = await getCurrentUser();
    revalidateRequest(await runRequestService.close(user, formToObject(formData)));
    return undefined;
  });
}
