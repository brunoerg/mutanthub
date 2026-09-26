"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { MonacoDiff } from "@/components/code/monaco-diff";
import { MUTATION_OPERATORS } from "@/domain/mutants/operators";
import { generateUnifiedDiff } from "@/domain/mutants/diff";
import type { MutationOperator } from "@/generated/prisma/enums";
import { routes } from "@/lib/routes";
import { lineRangeLabel, shortSha } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  previewDuplicatesAction,
  submitMutantAction,
  type DuplicatePreviewItem,
  type SubmitMutantResult,
} from "@/server/actions/mutant-actions";
import type { ActionResult } from "@/server/actions/result";

export interface SuggestMutantDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: { id: string; owner: string; repo: string; displayName: string };
  commitSha: string;
  filePath: string;
  language: string;
  /** All lines of the file (1-based indexing is applied internally). */
  lines: string[];
  selectedLine: number;
  /** Last line of the selection in the viewer; defaults to a single line. */
  selectedEndLine?: number;
  /** Called after a successful submission so the parent can refresh indicators. */
  onSubmitted?: (mutantId: number) => void;
  /** Scopes the submission to a tracked pull request (pull request mode). */
  pullRequestNumber?: number | null;
  /** Pull request mode: last line of the changed block containing the selected line. */
  lineLimit?: number | null;
}

const OBSERVED_OPTIONS: Array<{
  value: "SURVIVED" | "KILLED" | "UNKNOWN";
  label: string;
  hint: string;
}> = [
  { value: "SURVIVED", label: "Survived", hint: "All tests passed with the mutant applied" },
  { value: "KILLED", label: "Killed", hint: "At least one test failed" },
  { value: "UNKNOWN", label: "Unknown", hint: "Could not determine" },
];

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="text-destructive text-xs" role="alert">
      {message}
    </p>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-xs">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children}
      {hint && !error ? <p className="text-muted-foreground text-[11px]">{hint}</p> : null}
      <FieldError message={error} />
    </div>
  );
}

/**
 * Large side drawer for submitting a mutant that was tested locally. The
 * original source stays visible behind it. Commands are stored as text only.
 */
export function SuggestMutantDrawer(props: SuggestMutantDrawerProps) {
  const {
    open,
    onOpenChange,
    project,
    commitSha,
    filePath,
    language,
    lines,
    selectedLine,
    selectedEndLine,
    onSubmitted,
    pullRequestNumber = null,
    lineLimit = null,
  } = props;
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<
    ActionResult<SubmitMutantResult> | null,
    FormData
  >(submitMutantAction, null);
  const errors = (!state || state.ok ? {} : (state.fieldErrors ?? {})) as Record<
    string,
    string | undefined
  >;

  const rangeText = (from: number, to: number) =>
    lines.slice(from - 1, Math.max(from, to)).join("\n");

  const maxEndLine = Math.min(lines.length || selectedLine, lineLimit ?? Number.MAX_SAFE_INTEGER);
  // The parent keys this component by commit + file + selection, so initial state can come straight from props.
  const initialEndLine = Math.min(
    Math.max(selectedEndLine ?? selectedLine, selectedLine),
    maxEndLine,
  );
  const [endLine, setEndLine] = useState(initialEndLine);
  const [operator, setOperator] = useState<MutationOperator>("UNKNOWN");
  /** Always the file's own lines: the range is what the contributor edits, not the text. */
  const originalCode = rangeText(selectedLine, endLine);
  const [mutatedCode, setMutatedCode] = useState(originalCode);
  /** "Delete these lines": the mutant removes the original block without replacement. */
  const [deleteLines, setDeleteLines] = useState(false);
  const [gitDiff, setGitDiff] = useState("");
  const [observed, setObserved] = useState<"SURVIVED" | "KILLED" | "UNKNOWN">("SURVIVED");
  const [duplicates, setDuplicates] = useState<DuplicatePreviewItem[]>([]);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  /** Id of the last submission the user dismissed with "Submit another". */
  const [dismissedId, setDismissedId] = useState<number | null>(null);
  const [formKey, setFormKey] = useState(0);
  const lastNotified = useRef<ActionResult<SubmitMutantResult> | null>(null);

  const submitted: SubmitMutantResult | null =
    state?.ok && state.data.mutantId !== dismissedId ? state.data : null;
  const canCheckDuplicates =
    open &&
    originalCode.trim().length > 0 &&
    (deleteLines || mutatedCode.trim().length > 0) &&
    originalCode.trim() !== mutatedCode.trim();

  const handleEndLineChange = (value: number) => {
    const next = Math.min(Math.max(value, selectedLine), maxEndLine);
    setEndLine(next);
    // An untouched copy of the original follows the range; an edited one is kept.
    if (mutatedCode === originalCode) setMutatedCode(rangeText(selectedLine, next));
    setDuplicates([]);
  };

  // Debounced duplicate preview (results are cleared by the code onChange handlers).
  useEffect(() => {
    if (!canCheckDuplicates) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setCheckingDuplicates(true);
      const result = await previewDuplicatesAction({
        projectId: project.id,
        commitSha,
        filePath,
        startLine: selectedLine,
        originalCode,
        mutatedCode,
      });
      if (cancelled) return;
      setCheckingDuplicates(false);
      setDuplicates(result.ok ? result.data : []);
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    canCheckDuplicates,
    originalCode,
    mutatedCode,
    project.id,
    commitSha,
    filePath,
    selectedLine,
  ]);

  // Side effects of a new action result (toast, refresh gutter indicators); runs once per result.
  useEffect(() => {
    if (!state || state === lastNotified.current) return;
    lastNotified.current = state;
    if (state.ok) {
      toast.success(`Mutant #${state.data.mutantId} submitted`);
      onSubmitted?.(state.data.mutantId);
      router.refresh();
    } else if (!state.fieldErrors) {
      toast.error(state.error);
    }
  }, [state, onSubmitted, router]);

  const generateDiff = () => {
    setGitDiff(
      generateUnifiedDiff({ filePath, startLine: selectedLine, originalCode, mutatedCode }),
    );
  };

  const resetForAnother = () => {
    if (submitted) setDismissedId(submitted.mutantId);
    setMutatedCode(originalCode);
    setDeleteLines(false);
    setGitDiff("");
    setDuplicates([]);
    setOperator("UNKNOWN");
    setObserved("SURVIVED");
    setFormKey((k) => k + 1);
  };

  const showPreview = useMemo(
    () => originalCode.trim().length > 0 && (deleteLines || mutatedCode.trim().length > 0),
    [originalCode, mutatedCode, deleteLines],
  );

  const toggleDeleteLines = (checked: boolean) => {
    setDeleteLines(checked);
    setDuplicates([]);
    if (checked) {
      setMutatedCode("");
      setOperator("STATEMENT_DELETION");
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 data-[side=right]:sm:max-w-3xl data-[side=right]:lg:max-w-4xl data-[side=right]:xl:max-w-5xl"
        data-testid="suggest-mutant-drawer"
      >
        <SheetHeader className="border-border border-b px-5 py-3">
          <SheetTitle className="text-base">Suggest mutant</SheetTitle>
          <SheetDescription className="text-xs">
            Describe a mutation you applied and tested locally. Reviewers will verify it before it
            joins the catalogue.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Pre-filled context */}
          <dl className="border-border bg-muted/30 grid grid-cols-2 gap-x-4 gap-y-1 border-b px-5 py-3 font-mono text-xs sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground text-[10px] tracking-wide uppercase">Project</dt>
              <dd className="truncate" title={project.displayName}>
                {project.owner}/{project.repo}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-[10px] tracking-wide uppercase">Commit</dt>
              <dd title={commitSha}>{shortSha(commitSha)}</dd>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <dt className="text-muted-foreground text-[10px] tracking-wide uppercase">File</dt>
              <dd className="truncate" title={filePath}>
                {filePath}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-[10px] tracking-wide uppercase">Line</dt>
              <dd data-testid="drawer-line">{lineRangeLabel(selectedLine, endLine, "L")}</dd>
            </div>
          </dl>

          {submitted ? (
            <div className="px-5 py-8" data-testid="mutant-success">
              <div className="flex flex-col items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-6 text-center">
                <CheckCircle2
                  className="size-6 text-emerald-600 dark:text-emerald-400"
                  aria-hidden
                />
                <div>
                  <p className="font-medium">Mutant #{submitted.mutantId} submitted</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    It is now pending review. Other contributors can attempt to reproduce it once
                    approved.
                  </p>
                </div>
                {submitted.duplicateIds.length > 0 ? (
                  <Alert className="text-left">
                    <AlertTriangle className="size-4" aria-hidden />
                    <AlertTitle>Possible duplicate</AlertTitle>
                    <AlertDescription>
                      Similar mutants already exist:{" "}
                      {submitted.duplicateIds.map((id, i) => (
                        <span key={id}>
                          {i > 0 ? ", " : null}
                          <Link href={routes.mutant(id)} className="font-mono underline">
                            #{id}
                          </Link>
                        </span>
                      ))}
                      . Reviewers may mark yours as a duplicate.
                    </AlertDescription>
                  </Alert>
                ) : null}
                <div className="flex gap-2">
                  <Button asChild size="sm" data-testid="mutant-success-link">
                    <Link href={routes.mutant(submitted.mutantId)}>View mutant</Link>
                  </Button>
                  <Button variant="outline" size="sm" onClick={resetForAnother}>
                    Submit another
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <form
              key={formKey}
              action={formAction}
              className="space-y-6 px-5 py-4"
              data-testid="suggest-mutant-form"
            >
              <input type="hidden" name="projectId" value={project.id} />
              <input type="hidden" name="commitSha" value={commitSha} />
              {pullRequestNumber ? (
                <input type="hidden" name="pullRequestNumber" value={pullRequestNumber} />
              ) : null}
              <input type="hidden" name="filePath" value={filePath} />
              <input type="hidden" name="startLine" value={selectedLine} />
              <input type="hidden" name="mutationOperator" value={operator} />
              <input type="hidden" name="observedResult" value={observed} />

              {state && !state.ok ? (
                <Alert variant="destructive">
                  <AlertTriangle className="size-4" aria-hidden />
                  <AlertTitle>Could not submit</AlertTitle>
                  <AlertDescription>{state.error}</AlertDescription>
                </Alert>
              ) : null}

              {/* ---------------- Mutation ---------------- */}
              <section className="space-y-4">
                <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                  Mutation
                </h3>
                <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
                  <Field
                    label="Title"
                    htmlFor="title"
                    error={errors.title}
                    hint="Optional: generated from the operator and location when left empty"
                  >
                    <Input
                      id="title"
                      name="title"
                      placeholder="e.g. Relax bounds check in CheckMinimalPush"
                      data-testid="mutant-title"
                    />
                  </Field>
                  <Field
                    label="End line"
                    htmlFor="endLine"
                    error={errors.endLine}
                    hint={
                      lineLimit
                        ? `Pull request mode: only the changed block, up to L${lineLimit}`
                        : "Extend for multi-line mutations"
                    }
                  >
                    <Input
                      id="endLine"
                      name="endLine"
                      type="number"
                      min={selectedLine}
                      max={maxEndLine || undefined}
                      value={endLine}
                      onChange={(e) => handleEndLineChange(Number(e.target.value) || selectedLine)}
                      className="w-24 font-mono"
                    />
                  </Field>
                </div>

                <Field
                  label="Mutation operator"
                  htmlFor="mutationOperator"
                  error={errors.mutationOperator}
                >
                  <Select
                    value={operator}
                    onValueChange={(v) => setOperator(v as MutationOperator)}
                  >
                    <SelectTrigger
                      id="mutationOperator"
                      className="w-full"
                      data-testid="mutant-operator"
                    >
                      <SelectValue placeholder="Choose an operator" />
                    </SelectTrigger>
                    <SelectContent>
                      {MUTATION_OPERATORS.map((op) => (
                        <SelectItem key={op.value} value={op.value}>
                          <span className="flex flex-col">
                            <span>{op.label}</span>
                            <span className="text-muted-foreground text-[11px]">
                              {op.description}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <div className="grid gap-4 md:grid-cols-2">
                  <Field
                    label="Original code"
                    htmlFor="originalCode"
                    required
                    error={errors.originalCode}
                    hint={`Exactly ${lineRangeLabel(selectedLine, endLine, "L")} of the file; change the end line to cover more`}
                  >
                    <Textarea
                      id="originalCode"
                      name="originalCode"
                      value={originalCode}
                      readOnly
                      spellCheck={false}
                      className="min-h-28 font-mono text-xs read-only:opacity-60"
                      data-testid="mutant-original"
                      required
                    />
                  </Field>
                  <Field
                    label="Mutated code"
                    htmlFor="mutatedCode"
                    required={!deleteLines}
                    error={errors.mutatedCode}
                    hint={
                      deleteLines
                        ? "The original lines are removed without replacement"
                        : "The same lines after your change"
                    }
                  >
                    <Textarea
                      id="mutatedCode"
                      name="mutatedCode"
                      value={mutatedCode}
                      onChange={(e) => {
                        setMutatedCode(e.target.value);
                        setDuplicates([]);
                      }}
                      spellCheck={false}
                      readOnly={deleteLines}
                      placeholder={deleteLines ? "(lines deleted)" : undefined}
                      className="min-h-28 font-mono text-xs read-only:opacity-60"
                      data-testid="mutant-mutated"
                      required={!deleteLines}
                    />
                    <label className="mt-1.5 flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={deleteLines}
                        onChange={(e) => toggleDeleteLines(e.target.checked)}
                        className="accent-primary size-3.5"
                        data-testid="mutant-delete-lines"
                      />
                      Delete these lines (no replacement)
                    </label>
                  </Field>
                </div>

                {showPreview ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Diff preview</Label>
                    <MonacoDiff
                      original={originalCode}
                      modified={mutatedCode}
                      language={language}
                      height={200}
                      className="border-border overflow-hidden rounded-md border"
                    />
                  </div>
                ) : null}

                <Field
                  label="Git diff"
                  htmlFor="gitDiff"
                  error={errors.gitDiff}
                  hint="Paste the output of git diff, or generate a minimal patch from the code above. Left empty, a patch is generated on submit."
                >
                  <div className="space-y-1.5">
                    <Textarea
                      id="gitDiff"
                      name="gitDiff"
                      value={gitDiff}
                      onChange={(e) => setGitDiff(e.target.value)}
                      spellCheck={false}
                      placeholder={"--- a/path\n+++ b/path\n@@ -1,1 +1,1 @@\n-old\n+new"}
                      className="min-h-32 font-mono text-xs"
                      data-testid="mutant-diff"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={generateDiff}
                      disabled={!showPreview}
                    >
                      <Wand2 className="size-3" aria-hidden /> Generate from code
                    </Button>
                  </div>
                </Field>

                <Field
                  label="Description"
                  htmlFor="description"
                  error={errors.description}
                  hint="Optional: why this mutant is interesting, expected behaviour change, context"
                >
                  <Textarea id="description" name="description" className="min-h-16 text-xs" />
                </Field>

                {checkingDuplicates ? (
                  <p className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                    <Loader2 className="size-3 animate-spin" aria-hidden /> Checking for similar
                    mutants…
                  </p>
                ) : duplicates.length > 0 ? (
                  <Alert
                    className="border-amber-500/40 bg-amber-500/5"
                    data-testid="duplicate-warning"
                  >
                    <AlertTriangle className="size-4 text-amber-600" aria-hidden />
                    <AlertTitle>Possible duplicate</AlertTitle>
                    <AlertDescription>
                      <ul className="mt-1 space-y-0.5">
                        {duplicates.map((d) => (
                          <li key={d.id} className="text-xs">
                            <Link
                              href={routes.mutant(d.id)}
                              target="_blank"
                              className="font-mono underline"
                            >
                              #{d.id}
                            </Link>{" "}
                            {d.title}{" "}
                            <span className="text-muted-foreground font-mono">
                              ({shortSha(d.commitSha)}, {d.exact ? "exact" : "similar"})
                            </span>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1 text-[11px]">
                        You can still submit; reviewers decide whether it is a duplicate.
                      </p>
                    </AlertDescription>
                  </Alert>
                ) : null}
              </section>

              {/* ---------------- Testing ---------------- */}
              <section className="space-y-4">
                <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                  How did you test it?
                </h3>
                <p className="text-muted-foreground flex items-start gap-1.5 text-[11px]">
                  <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
                  Commands are stored as text for reviewers and are never executed by MutantHub.
                </p>
                <Field label="Build command" htmlFor="buildCommand" error={errors.buildCommand}>
                  <Input
                    id="buildCommand"
                    name="buildCommand"
                    placeholder="cmake --build build -j8"
                    className="font-mono text-xs"
                  />
                </Field>
                <Field
                  label="Test command"
                  htmlFor="testCommand"
                  required
                  error={errors.testCommand}
                >
                  <Input
                    id="testCommand"
                    name="testCommand"
                    placeholder="ctest --test-dir build"
                    className="font-mono text-xs"
                    data-testid="mutant-test-command"
                    required
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Fuzz command" htmlFor="fuzzCommand" error={errors.fuzzCommand}>
                    <Input
                      id="fuzzCommand"
                      name="fuzzCommand"
                      placeholder="optional"
                      className="font-mono text-xs"
                    />
                  </Field>
                  <Field
                    label="Execution duration (seconds)"
                    htmlFor="testDurationSeconds"
                    error={errors.testDurationSeconds}
                  >
                    <Input
                      id="testDurationSeconds"
                      name="testDurationSeconds"
                      type="number"
                      min={0}
                      placeholder="e.g. 900"
                      className="font-mono text-xs"
                    />
                  </Field>
                </div>
                <Field
                  label="Environment"
                  htmlFor="environmentDescription"
                  error={errors.environmentDescription}
                  hint="Optional but helps reproduction: OS, compiler, toolchain versions, relevant flags"
                >
                  <Textarea
                    id="environmentDescription"
                    name="environmentDescription"
                    placeholder="Ubuntu 24.04, gcc 14.2, Boost 1.83"
                    className="min-h-16 text-xs"
                    data-testid="mutant-environment"
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Operating system"
                    htmlFor="operatingSystem"
                    error={errors.operatingSystem}
                  >
                    <Input
                      id="operatingSystem"
                      name="operatingSystem"
                      placeholder="Linux"
                      className="text-xs"
                    />
                  </Field>
                  <Field label="Compiler" htmlFor="compiler" error={errors.compiler}>
                    <Input
                      id="compiler"
                      name="compiler"
                      placeholder="gcc 14.2"
                      className="text-xs"
                    />
                  </Field>
                </div>

                <fieldset className="space-y-1.5">
                  <legend className="text-xs font-medium">
                    Observed result <span className="text-destructive">*</span>
                  </legend>
                  <div className="grid gap-2 sm:grid-cols-3" role="radiogroup">
                    {OBSERVED_OPTIONS.map((opt) => (
                      <label
                        key={opt.value}
                        className={cn(
                          "flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors",
                          observed === opt.value
                            ? "border-primary bg-primary/5"
                            : "border-border hover:bg-muted",
                        )}
                      >
                        <input
                          type="radio"
                          value={opt.value}
                          checked={observed === opt.value}
                          onChange={() => setObserved(opt.value)}
                          className="mt-0.5"
                          data-testid={`observed-${opt.value.toLowerCase()}`}
                        />
                        <span>
                          <span className="font-medium">{opt.label}</span>
                          <span className="text-muted-foreground block text-[11px]">
                            {opt.hint}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <FieldError message={errors.observedResult} />
                </fieldset>

                <Field
                  label="Notes"
                  htmlFor="notes"
                  error={errors.notes}
                  hint="Anything a reviewer or reproducer should know"
                >
                  <Textarea id="notes" name="notes" className="min-h-16 text-xs" />
                </Field>
              </section>

              <div className="border-border bg-popover sticky bottom-0 -mx-5 flex items-center justify-end gap-2 border-t px-5 py-3">
                <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={isPending} data-testid="mutant-submit">
                  {isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                  Submit mutant
                </Button>
              </div>
            </form>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
