"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { closeRunRequestAction } from "@/server/actions/run-request-actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/** Requester or reviewer: close as fulfilled, or cancel. */
export function CloseRunRequestForm({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [, formAction, pending] = useActionState(
    async (prev: Awaited<ReturnType<typeof closeRunRequestAction>> | null, formData: FormData) => {
      const result = await closeRunRequestAction(prev, formData);
      if (result.ok) {
        toast.success("Request closed");
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    null,
  );
  return (
    <form action={formAction} className="space-y-2" data-testid="close-run-request-form">
      <input type="hidden" name="requestId" value={requestId} />
      <Textarea name="reason" rows={2} placeholder="Optional note" className="text-xs" />
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          name="outcome"
          value="CLOSED"
          size="sm"
          variant="outline"
          disabled={pending}
          data-testid="run-request-close"
        >
          Close as fulfilled
        </Button>
        <Button
          type="submit"
          name="outcome"
          value="CANCELLED"
          size="sm"
          variant="ghost"
          disabled={pending}
          data-testid="run-request-cancel"
        >
          Cancel request
        </Button>
      </div>
    </form>
  );
}
