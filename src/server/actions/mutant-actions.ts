"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/server/auth/session";
import { mutantService } from "@/server/services/mutant-service";
import { interactionService } from "@/server/services/interaction-service";
import { reviewService } from "@/server/services/review-service";
import { routes } from "@/lib/routes";
import { formToObject, runAction, type ActionResult } from "./result";
import { headers } from "next/headers";
import { enforceRateLimit } from "@/server/infra/rate-limit";

export interface SubmitMutantResult {
  mutantId: number;
  duplicateIds: number[];
}

export async function submitMutantAction(
  _prev: ActionResult<SubmitMutantResult> | null,
  formData: FormData,
): Promise<ActionResult<SubmitMutantResult>> {
  return runAction(async () => {
    const user = await getCurrentUser();
    const { mutant, duplicates } = await mutantService.submitMutant(user, formToObject(formData));
    revalidatePath(routes.mutants());
    revalidatePath(routes.review());
    return {
      mutantId: mutant.id,
      duplicateIds: [...duplicates.exact, ...duplicates.similar].map((d) => d.id),
    };
  });
}

export interface DuplicatePreviewItem {
  id: number;
  title: string;
  commitSha: string;
  reviewStatus: string;
  exact: boolean;
}

export async function previewDuplicatesAction(input: {
  projectId: string;
  commitSha: string;
  filePath: string;
  startLine: number;
  originalCode: string;
  mutatedCode: string;
}): Promise<ActionResult<DuplicatePreviewItem[]>> {
  return runAction(async () => {
    if (!input.originalCode.trim()) return [];
    // Public, read-only, but it runs text searches: cap it per user or client address.
    const user = await getCurrentUser();
    const requestHeaders = await headers();
    const subject =
      user?.id ??
      requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      requestHeaders.get("x-real-ip") ??
      "anonymous";
    await enforceRateLimit({ action: "preview-duplicates", subject, limit: 120, windowMs: 60_000 });
    const result = await mutantService.previewDuplicates(input);
    return [
      ...result.exact.map((m) => ({
        id: m.id,
        title: m.title,
        commitSha: m.revision.commitSha,
        reviewStatus: m.reviewStatus,
        exact: true,
      })),
      ...result.similar.map((m) => ({
        id: m.id,
        title: m.title,
        commitSha: m.revision.commitSha,
        reviewStatus: m.reviewStatus,
        exact: false,
      })),
    ];
  });
}

export async function addValidationAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const user = await getCurrentUser();
    const validation = await interactionService.addValidation(user, formToObject(formData));
    revalidatePath(routes.mutant(validation.mutantId));
    return { id: validation.id };
  });
}

export async function addCommentAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const user = await getCurrentUser();
    const comment = await interactionService.addComment(user, formToObject(formData));
    revalidatePath(routes.mutant(comment.mutantId));
    return { id: comment.id };
  });
}

export async function reviewMutantAction(
  _prev: ActionResult<{ mutantId: number; reviewStatus: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ mutantId: number; reviewStatus: string }>> {
  return runAction(async () => {
    const user = await getCurrentUser();
    const updated = await reviewService.review(user, formToObject(formData));
    revalidatePath(routes.review());
    revalidatePath(routes.mutant(updated.id));
    return { mutantId: updated.id, reviewStatus: updated.reviewStatus };
  });
}

export async function changeMutationStatusAction(
  _prev: ActionResult<{ mutantId: number; mutationStatus: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ mutantId: number; mutationStatus: string }>> {
  return runAction(async () => {
    const user = await getCurrentUser();
    const updated = await reviewService.changeMutationStatus(user, formToObject(formData));
    revalidatePath(routes.review());
    revalidatePath(routes.mutant(updated.id));
    return { mutantId: updated.id, mutationStatus: updated.mutationStatus };
  });
}

export interface EditMutantResult {
  mutantId: number;
  changedFields: string[];
  duplicateIds: number[];
}

export async function editMutantAction(
  _prev: ActionResult<EditMutantResult> | null,
  formData: FormData,
): Promise<ActionResult<EditMutantResult>> {
  return runAction(async () => {
    const user = await getCurrentUser();
    const { mutant, duplicates, changedFields } = await mutantService.editMutant(
      user,
      formToObject(formData),
    );
    revalidatePath(routes.mutant(mutant.id));
    revalidatePath(routes.review());
    return {
      mutantId: mutant.id,
      changedFields,
      duplicateIds: [...duplicates.exact, ...duplicates.similar].map((d) => d.id),
    };
  });
}

export async function editDescriptionAction(
  _prev: ActionResult<{ mutantId: number; changed: boolean }> | null,
  formData: FormData,
): Promise<ActionResult<{ mutantId: number; changed: boolean }>> {
  return runAction(async () => {
    const user = await getCurrentUser();
    const { mutant, changed } = await mutantService.editDescription(user, formToObject(formData));
    revalidatePath(routes.mutant(mutant.id));
    return { mutantId: mutant.id, changed };
  });
}

export async function editTitleAction(
  _prev: ActionResult<{ mutantId: number; changed: boolean }> | null,
  formData: FormData,
): Promise<ActionResult<{ mutantId: number; changed: boolean }>> {
  return runAction(async () => {
    const user = await getCurrentUser();
    const { mutant, changed } = await mutantService.editTitle(user, formToObject(formData));
    revalidatePath(routes.mutant(mutant.id));
    return { mutantId: mutant.id, changed };
  });
}

export async function resubmitMutantAction(
  _prev: ActionResult<{ mutantId: number }> | null,
  formData: FormData,
): Promise<ActionResult<{ mutantId: number }>> {
  return runAction(async () => {
    const user = await getCurrentUser();
    const updated = await mutantService.resubmitMutant(user, formToObject(formData));
    revalidatePath(routes.mutant(updated.id));
    revalidatePath(routes.review());
    return { mutantId: updated.id };
  });
}

export async function withdrawMutantAction(
  _prev: ActionResult<{ mutantId: number }> | null,
  formData: FormData,
): Promise<ActionResult<{ mutantId: number }>> {
  return runAction(async () => {
    const user = await getCurrentUser();
    const updated = await mutantService.withdrawMutant(user, formToObject(formData));
    revalidatePath(routes.mutant(updated.id));
    revalidatePath(routes.review());
    return { mutantId: updated.id };
  });
}
