import Link from "next/link";
import { ChevronDown, Filter, X } from "lucide-react";
import type {
  DriftStatus,
  MutationOperator,
  MutationStatus,
  ReviewStatus,
} from "@/generated/prisma/enums";
import { DRIFT_STATUSES, DRIFT_STATUS_LABEL } from "@/domain/drift/status";
import { MUTATION_OPERATORS } from "@/domain/mutants/operators";
import {
  MUTATION_STATUSES,
  MUTATION_STATUS_LABEL,
  REVIEW_STATUSES,
  REVIEW_STATUS_LABEL,
} from "@/domain/mutants/status";
import { AutoSubmitSelect } from "@/components/mutants/auto-submit-select";
import { ContributorSelect } from "@/components/mutants/contributor-select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------------ */
/* Primitive, JS-free filter controls (native form elements styled like     */
/* shadcn inputs). Shared by the mutant list and the review queue filters.  */
/* ------------------------------------------------------------------------ */

const CONTROL_CLASS =
  "h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export interface FilterOption {
  value: string;
  label: string;
}

export function FilterField({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

export function FilterSelect({
  name,
  value,
  options,
  placeholder = "Any",
  testId,
  autoSubmit,
}: {
  name: string;
  value?: string;
  options: FilterOption[];
  placeholder?: string;
  testId?: string;
  /** Submit the form on change instead of waiting for Apply. */
  autoSubmit?: boolean;
}) {
  const Select = autoSubmit ? AutoSubmitSelect : "select";
  return (
    <Select name={name} defaultValue={value ?? ""} className={CONTROL_CLASS} data-testid={testId}>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}

export function FilterInput({
  name,
  value,
  placeholder,
  type = "text",
  mono,
  testId,
}: {
  name: string;
  value?: string;
  placeholder?: string;
  type?: "text" | "date";
  mono?: boolean;
  testId?: string;
}) {
  return (
    <input
      type={type}
      name={name}
      defaultValue={value ?? ""}
      placeholder={placeholder}
      className={cn(CONTROL_CLASS, mono && "font-mono")}
      data-testid={testId}
    />
  );
}

export const OPERATOR_OPTIONS: FilterOption[] = MUTATION_OPERATORS.map((o) => ({
  value: o.value,
  label: o.label,
}));
export const REVIEW_STATUS_OPTIONS: FilterOption[] = REVIEW_STATUSES.map((s) => ({
  value: s,
  label: REVIEW_STATUS_LABEL[s],
}));
export const MUTATION_STATUS_OPTIONS: FilterOption[] = MUTATION_STATUSES.map((s) => ({
  value: s,
  label: MUTATION_STATUS_LABEL[s],
}));
export const SUPERSEDED_OPTIONS: FilterOption[] = [
  { value: "show", label: "Show all" },
  { value: "only", label: "Only superseded" },
];

/**
 * The list pages hide superseded mutants unless the URL asks to "show" them or
 * for "only" them; the API shows them by default. Returns the page's value and
 * the matching API filter.
 */
export function supersededView(raw?: string) {
  const view: "show" | "only" | undefined = raw === "show" || raw === "only" ? raw : undefined;
  const filter = view === "show" ? undefined : (view ?? "hide");
  return { view, filter };
}
export const DRIFT_STATUS_OPTIONS: FilterOption[] = DRIFT_STATUSES.map((s) => ({
  value: s,
  label: DRIFT_STATUS_LABEL[s],
}));

/** Builds a query string from a filter object, dropping empty values. */
export function buildQuery(values: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(key, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/* ------------------------------------------------------------------------ */
/* Mutant list filters                                                        */
/* ------------------------------------------------------------------------ */

export interface MutantFilterValues {
  project?: string;
  operator?: MutationOperator;
  reviewStatus?: ReviewStatus;
  mutationStatus?: MutationStatus;
  contributor?: string;
  commit?: string;
  file?: string;
  q?: string;
  /** Import batch id; carried as a hidden field so it survives re-filtering. */
  batch?: string;
  drift?: DriftStatus;
  /** Page value; hiding superseded mutants is the default (see supersededView). */
  superseded?: "show" | "only";
  since?: string;
  until?: string;
  /** Not a filter: kept in the query but never shown as a chip. */
  sort?: "oldest";
}

const SORT_OPTIONS: FilterOption[] = [{ value: "oldest", label: "Oldest first" }];

const FILTER_LABELS: Record<Exclude<keyof MutantFilterValues, "sort">, string> = {
  q: "Search",
  project: "Project",
  mutationStatus: "Mutant status",
  reviewStatus: "Review",
  operator: "Operator",
  contributor: "Contributor",
  file: "File",
  commit: "Commit",
  since: "Created from",
  until: "Created to",
  drift: "At HEAD",
  superseded: "Superseded",
  batch: "Import batch",
};

const FILTER_VALUE_OPTIONS: Partial<Record<keyof MutantFilterValues, FilterOption[]>> = {
  operator: OPERATOR_OPTIONS,
  reviewStatus: REVIEW_STATUS_OPTIONS,
  mutationStatus: MUTATION_STATUS_OPTIONS,
  drift: DRIFT_STATUS_OPTIONS,
  superseded: SUPERSEDED_OPTIONS,
};

interface MutantFiltersProps {
  action: string;
  values: MutantFilterValues;
  projects: FilterOption[];
  /** Usernames offered by the contributor picker. */
  contributors: string[];
  /** When true the project select is hidden (project pages). */
  lockProject?: boolean;
}

export function MutantFilters({
  action,
  values,
  projects,
  contributors,
  lockProject,
}: MutantFiltersProps) {
  const current = { ...values, project: lockProject ? undefined : values.project };
  const chips = (Object.keys(FILTER_LABELS) as (keyof typeof FILTER_LABELS)[]).flatMap((key) => {
    const value = current[key];
    if (!value) return [];
    const display = FILTER_VALUE_OPTIONS[key]?.find((o) => o.value === value)?.label ?? value;
    return [
      {
        key,
        label: `${FILTER_LABELS[key]}: ${display}`,
        href: `${action}${buildQuery({ ...current, [key]: undefined })}`,
      },
    ];
  });
  const active = chips.length;
  return (
    <form
      // Remount on navigation so uncontrolled fields pick up the new defaultValues
      // (e.g. after removing a chip).
      key={JSON.stringify(values)}
      method="get"
      action={action}
      className="border-border bg-card rounded-lg border p-3"
      data-testid="mutant-filters"
    >
      {values.batch ? <input type="hidden" name="batch" value={values.batch} /> : null}
      <div
        className={cn(
          "grid grid-cols-2 gap-2 md:grid-cols-4",
          lockProject ? "xl:grid-cols-6" : "xl:grid-cols-7",
        )}
      >
        <FilterField label="Search" className="col-span-2">
          <FilterInput
            name="q"
            value={values.q}
            placeholder="title, code, path"
            testId="filter-q"
          />
        </FilterField>
        {lockProject ? null : (
          <FilterField label="Project">
            <FilterSelect
              autoSubmit
              name="project"
              value={values.project}
              options={projects}
              placeholder="All projects"
              testId="filter-project"
            />
          </FilterField>
        )}
        <FilterField label="Mutant status">
          <FilterSelect
            autoSubmit
            name="mutationStatus"
            value={values.mutationStatus}
            options={MUTATION_STATUS_OPTIONS}
            testId="filter-mutation-status"
          />
        </FilterField>
        <FilterField label="Review">
          <FilterSelect
            autoSubmit
            name="reviewStatus"
            value={values.reviewStatus}
            options={REVIEW_STATUS_OPTIONS}
            testId="filter-review-status"
          />
        </FilterField>
        <FilterField label="Operator">
          <FilterSelect
            autoSubmit
            name="operator"
            value={values.operator}
            options={OPERATOR_OPTIONS}
            testId="filter-operator"
          />
        </FilterField>
        <FilterField label="Contributor">
          <ContributorSelect
            name="contributor"
            value={values.contributor}
            options={contributors}
            className={CONTROL_CLASS}
            testId="filter-contributor"
          />
        </FilterField>
      </div>
      <details
        className="group mt-2"
        open={Boolean(
          values.file ||
          values.commit ||
          values.since ||
          values.until ||
          values.drift ||
          values.superseded,
        )}
        data-testid="filter-more"
      >
        <summary className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer list-none items-center gap-1 text-xs [&::-webkit-details-marker]:hidden">
          <ChevronDown
            className="size-3.5 transition-transform group-open:rotate-180"
            aria-hidden
          />
          More filters
        </summary>
        <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
          <FilterField label="File">
            <FilterInput
              name="file"
              value={values.file}
              placeholder="path contains"
              mono
              testId="filter-file"
            />
          </FilterField>
          <FilterField label="Commit">
            <FilterInput
              name="commit"
              value={values.commit}
              placeholder="sha prefix"
              mono
              testId="filter-commit"
            />
          </FilterField>
          <FilterField label="Created from">
            <FilterInput name="since" value={values.since} type="date" testId="filter-since" />
          </FilterField>
          <FilterField label="Created to">
            <FilterInput name="until" value={values.until} type="date" testId="filter-until" />
          </FilterField>
          <FilterField label="At HEAD">
            <FilterSelect
              autoSubmit
              name="drift"
              value={values.drift}
              options={DRIFT_STATUS_OPTIONS}
              testId="filter-drift"
            />
          </FilterField>
          <FilterField label="Superseded">
            <FilterSelect
              autoSubmit
              name="superseded"
              value={values.superseded}
              options={SUPERSEDED_OPTIONS}
              placeholder="Hide (latest only)"
              testId="filter-superseded"
            />
          </FilterField>
        </div>
      </details>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {active ? (
            chips.map((chip) => (
              <span
                key={chip.key}
                className="border-border bg-muted/50 inline-flex max-w-64 items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5 text-xs"
                data-testid={`filter-chip-${chip.key}`}
              >
                <span className="truncate">{chip.label}</span>
                <Link
                  href={chip.href}
                  aria-label={`Remove ${chip.label}`}
                  className="text-muted-foreground hover:text-foreground hover:bg-muted rounded-full p-0.5"
                >
                  <X className="size-3" aria-hidden />
                </Link>
              </span>
            ))
          ) : (
            <span className="text-muted-foreground text-xs">No filters</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <label className="w-32">
            <span className="sr-only">Sort</span>
            <FilterSelect
              autoSubmit
              name="sort"
              value={values.sort}
              options={SORT_OPTIONS}
              placeholder="Newest first"
              testId="filter-sort"
            />
          </label>
          {active ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`${action}${buildQuery({ sort: values.sort })}`}>
                <X className="size-3.5" aria-hidden /> Clear
              </Link>
            </Button>
          ) : null}
          <Button type="submit" size="sm" variant="secondary" data-testid="filter-apply">
            <Filter className="size-3.5" aria-hidden /> Apply
          </Button>
        </div>
      </div>
    </form>
  );
}
