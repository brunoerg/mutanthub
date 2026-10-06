"use client";

import { startTransition, useActionState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { createRunRequestAction } from "@/server/actions/run-request-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface CreateRunRequestFormProps {
  projectId: string;
  owner: string;
  repo: string;
  /** Fixed pull request (PR page); without it the form asks for a number. */
  number?: number;
  /** Changed files offered as an optional scope. */
  files?: string[];
}

/** "Could someone run mutation testing on this PR?" */
export function CreateRunRequestForm({
  projectId,
  owner,
  repo,
  number,
  files = [],
}: CreateRunRequestFormProps) {
  const [state, formAction, pending] = useActionState(createRunRequestAction, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const formError = state && !state.ok && !state.fieldErrors ? state.error : undefined;

  return (
    <form
      // Submitted by hand so a rejected request keeps the notes (see ReportRunForm).
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => formAction(data));
      }}
      className="space-y-3"
      data-testid="create-run-request-form"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="owner" value={owner} />
      <input type="hidden" name="repo" value={repo} />
      {number ? (
        <input type="hidden" name="number" value={number} />
      ) : (
        <div className="space-y-1">
          <Label htmlFor="run-request-number" className="text-xs">
            Pull request number
          </Label>
          <Input
            id="run-request-number"
            name="number"
            type="number"
            min={1}
            placeholder="1234"
            className="w-36"
            required
            data-testid="run-request-number"
          />
          {errors.number ? <p className="text-destructive text-xs">{errors.number}</p> : null}
        </div>
      )}
      {files.length > 0 ? (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium">Focus on (optional)</legend>
          <p className="text-muted-foreground text-[11px]">Leave all unchecked for the whole PR.</p>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {files.map((f) => (
              <label key={f} className="flex items-center gap-2 font-mono text-xs">
                <input type="checkbox" name="files" value={f} data-testid="run-request-file" />
                <span className="truncate" title={f}>
                  {f}
                </span>
              </label>
            ))}
          </div>
          {errors.files ? <p className="text-destructive text-xs">{errors.files}</p> : null}
        </fieldset>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor="run-request-notes" className="text-xs">
          Notes for runners (optional)
        </Label>
        <Textarea
          id="run-request-notes"
          name="notes"
          rows={3}
          placeholder="What to focus on, how to build and test, which fuzz targets matter…"
          className="text-xs"
          data-testid="run-request-notes"
        />
        {errors.notes ? <p className="text-destructive text-xs">{errors.notes}</p> : null}
      </div>
      <Button type="submit" size="sm" disabled={pending} data-testid="run-request-submit">
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <FlaskConical className="size-3.5" aria-hidden />
        )}
        Request a run
      </Button>
      {formError ? <p className="text-destructive text-xs">{formError}</p> : null}
      <p className="text-muted-foreground text-[11px]">
        The request targets the pull request&apos;s current head commit. Project followers are
        notified, and anyone can claim it, run their tool and report the result.
      </p>
    </form>
  );
}
