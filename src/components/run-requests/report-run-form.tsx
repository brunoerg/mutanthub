"use client";

import { startTransition, useActionState, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ClipboardCheck, Loader2 } from "lucide-react";
import { reportRunAction } from "@/server/actions/run-request-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}

/** The runner's report: what was run, at which commit, and how many mutants survived. */
export function ReportRunForm({ requestId, headSha }: { requestId: string; headSha: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(
    async (prev: Awaited<ReturnType<typeof reportRunAction>> | null, formData: FormData) => {
      const result = await reportRunAction(prev, formData);
      if (result.ok) {
        toast.success("Run reported");
        formRef.current?.reset();
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    null,
  );
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const formError = state && !state.ok && !state.fieldErrors ? state.error : undefined;

  return (
    <form
      ref={formRef}
      // Submitted by hand so a rejected report keeps what the runner typed
      // (React resets a form after its `action` runs).
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => formAction(data));
      }}
      className="space-y-3"
      data-testid="report-run-form"
    >
      <input type="hidden" name="requestId" value={requestId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="run-tool" label="Tool" error={errors.toolName}>
          <Input
            id="run-tool"
            name="toolName"
            placeholder="mull, mutmut, cargo-mutants…"
            required
            data-testid="report-tool"
          />
        </Field>
        <Field id="run-tool-version" label="Version (optional)" error={errors.toolVersion}>
          <Input id="run-tool-version" name="toolVersion" placeholder="0.24.0" />
        </Field>
      </div>
      <Field id="run-commit" label="Commit you ran against" error={errors.commitSha}>
        <Input
          id="run-commit"
          name="commitSha"
          defaultValue={headSha}
          className="font-mono text-xs"
          required
          data-testid="report-commit"
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field id="run-generated" label="Generated" error={errors.generated}>
          <Input
            id="run-generated"
            name="generated"
            type="number"
            min={0}
            required
            data-testid="report-generated"
          />
        </Field>
        <Field id="run-killed" label="Killed" error={errors.killed}>
          <Input
            id="run-killed"
            name="killed"
            type="number"
            min={0}
            required
            data-testid="report-killed"
          />
        </Field>
        <Field id="run-survived" label="Survived" error={errors.survived}>
          <Input
            id="run-survived"
            name="survived"
            type="number"
            min={0}
            required
            data-testid="report-survived"
          />
        </Field>
      </div>
      <Field id="run-command" label="Command (optional)" error={errors.command}>
        <Textarea
          id="run-command"
          name="command"
          rows={2}
          className="font-mono text-xs"
          placeholder="mull-runner-17 ./build/test_bitcoin --ld-search-path …"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id="run-duration"
          label="Duration in seconds (optional)"
          error={errors.durationSeconds}
        >
          <Input id="run-duration" name="durationSeconds" type="number" min={0} />
        </Field>
        <Field id="run-environment" label="Environment (optional)" error={errors.environment}>
          <Input id="run-environment" name="environment" placeholder="Ubuntu 24.04, clang 18" />
        </Field>
      </div>
      <Field id="run-notes" label="Notes (optional)" error={errors.notes}>
        <Textarea
          id="run-notes"
          name="notes"
          rows={2}
          className="text-xs"
          placeholder="Timeouts, skipped files, anything the next runner should know"
        />
      </Field>
      <Button type="submit" size="sm" disabled={pending} data-testid="report-submit">
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <ClipboardCheck className="size-3.5" aria-hidden />
        )}
        Report run
      </Button>
      {formError ? <p className="text-destructive text-xs">{formError}</p> : null}
      <p className="text-muted-foreground text-[11px]">
        Report even when nothing survived: that is a result too. Submit each surviving mutant from
        the code browser in pull request mode so it can be reviewed and reproduced.
      </p>
    </form>
  );
}
