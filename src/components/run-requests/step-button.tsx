"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { runRequestStepAction } from "@/server/actions/run-request-actions";
import { Button } from "@/components/ui/button";

export type RunRequestStep = "vote" | "unvote" | "claim" | "abandon" | "retarget";

interface StepButtonProps {
  requestId: string;
  step: RunRequestStep;
  success: string;
  variant?: "default" | "outline" | "ghost";
  icon?: React.ReactNode;
  children: React.ReactNode;
}

/** A one-click step on a run request (vote, claim, abandon, retarget). */
export function RunRequestStepButton({
  requestId,
  step,
  success,
  variant = "outline",
  icon,
  children,
}: StepButtonProps) {
  const router = useRouter();
  const [, formAction, pending] = useActionState(
    async (prev: Awaited<ReturnType<typeof runRequestStepAction>> | null, formData: FormData) => {
      const result = await runRequestStepAction(prev, formData);
      if (result.ok) {
        toast.success(success);
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    null,
  );
  return (
    <form action={formAction}>
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="step" value={step} />
      <Button
        type="submit"
        size="sm"
        variant={variant}
        disabled={pending}
        data-testid={`run-request-${step}`}
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : icon}
        {children}
      </Button>
    </form>
  );
}
