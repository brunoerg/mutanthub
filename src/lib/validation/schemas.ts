import { z } from "zod";
import { LIMITS } from "./limits";

const trimmed = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined));

/** Optional numeric form field: missing or empty string becomes undefined. */
const optionalNumber = (schema: z.ZodType<number, unknown>) =>
  z
    .union([z.literal(""), schema])
    .optional()
    .transform((v) => (typeof v === "number" ? v : undefined));

export const mutationOperatorSchema = z.enum([
  "ARITHMETIC_OPERATOR",
  "RELATIONAL_OPERATOR",
  "CONDITIONAL_OPERATOR",
  "LOGICAL_OPERATOR",
  "CONSTANT_REPLACEMENT",
  "RETURN_VALUE",
  "STATEMENT_DELETION",
  "FUNCTION_CALL",
  "CUSTOM",
  "UNKNOWN",
]);

export const reviewStatusSchema = z.enum([
  "PENDING",
  "NEEDS_INFORMATION",
  "APPROVED",
  "REJECTED",
  "DUPLICATE",
  "WITHDRAWN",
]);

export const mutationStatusSchema = z.enum([
  "UNKNOWN",
  "SURVIVED",
  "KILLED",
  "EQUIVALENT",
  "INVALID",
]);

export const observedResultSchema = z.enum(["SURVIVED", "KILLED", "UNKNOWN"]);

export const driftStatusSchema = z.enum(["UNCHECKED", "APPLIES", "MOVED", "GONE"]);

export const validationResultSchema = z.enum(["SURVIVED", "KILLED", "COULD_NOT_REPRODUCE"]);

export const reviewActionSchema = z.enum([
  "APPROVE",
  "REJECT",
  "NEEDS_INFORMATION",
  "MARK_DUPLICATE",
]);

export const commitShaSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{7,40}$/i, "Must be a Git commit SHA");

export const filePathSchema = z
  .string()
  .trim()
  .min(1, "File path is required")
  .max(LIMITS.filePath)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "Invalid file path");

/** Fields describing the mutation itself (shared by submission and edits). */
const mutationFields = {
  /** Optional: generated from the operator and location when empty. */
  title: optionalText(LIMITS.title),
  mutationOperator: mutationOperatorSchema,
  originalCode: z.string().min(1, "Original code is required").max(LIMITS.code),
  /** Empty means the original lines are deleted (statement deletion). */
  mutatedCode: z.string().max(LIMITS.code).default(""),
  gitDiff: z.string().max(LIMITS.diff).default(""),
  description: optionalText(LIMITS.description),
};

/** Fields describing how the mutant was tested (shared by submission and edits). */
const evidenceFields = {
  buildCommand: optionalText(LIMITS.command),
  testCommand: trimmed(LIMITS.command).min(1, "Describe the command used to run the tests"),
  fuzzCommand: optionalText(LIMITS.command),
  testDurationSeconds: optionalNumber(
    z.coerce
      .number()
      .int()
      .min(0)
      .max(60 * 60 * 24 * 30),
  ),
  environmentDescription: optionalText(LIMITS.environment),
  operatingSystem: optionalText(200),
  compiler: optionalText(200),
  observedResult: observedResultSchema,
  notes: optionalText(LIMITS.notes),
  stdout: optionalText(LIMITS.log),
  stderr: optionalText(LIMITS.log),
};

const codeMustDiffer = {
  check: (v: { originalCode: string; mutatedCode: string }) =>
    v.originalCode.trim() !== v.mutatedCode.trim(),
  message: "Mutated code must differ from the original code",
  path: ["mutatedCode"],
};

export const submitMutantSchema = z
  .object({
    projectId: z.string().min(1),
    commitSha: commitShaSchema,
    filePath: filePathSchema,
    startLine: z.coerce.number().int().min(1),
    endLine: z.coerce.number().int().min(1),
    /** Present when the mutant is submitted from the code browser's pull request mode. */
    pullRequestNumber: optionalNumber(z.coerce.number().int().positive()),
    ...mutationFields,
    ...evidenceFields,
  })
  .refine((v) => v.endLine >= v.startLine, {
    message: "End line must be greater than or equal to start line",
    path: ["endLine"],
  })
  .refine(codeMustDiffer.check, { message: codeMustDiffer.message, path: codeMustDiffer.path });

/**
 * Editing an existing submission. The location (project, commit, file, line)
 * is immutable: a mutant at another location is a different mutant.
 */
export const editMutantSchema = z
  .object({
    mutantId: z.coerce.number().int().positive(),
    ...mutationFields,
    ...evidenceFields,
    /** Optional note for reviewers explaining what changed and why. */
    editReason: optionalText(LIMITS.editReason),
  })
  .refine(codeMustDiffer.check, { message: codeMustDiffer.message, path: codeMustDiffer.path });

export type EditMutantInput = z.infer<typeof editMutantSchema>;

/**
 * Editing only the description. Unlike a full edit this is allowed at any
 * review status: the description is prose, not evidence.
 */
export const editDescriptionSchema = z.object({
  mutantId: z.coerce.number().int().positive(),
  description: optionalText(LIMITS.description),
});

/** Editing only the title, allowed at any review status. Empty regenerates it. */
export const editTitleSchema = z.object({
  mutantId: z.coerce.number().int().positive(),
  title: optionalText(LIMITS.title),
});

export const withdrawMutantSchema = z.object({
  mutantId: z.coerce.number().int().positive(),
  reason: optionalText(LIMITS.reviewComment),
});

export const resubmitMutantSchema = z.object({
  mutantId: z.coerce.number().int().positive(),
  comment: optionalText(LIMITS.reviewComment),
});

export type SubmitMutantInput = z.infer<typeof submitMutantSchema>;

export const reviewMutantSchema = z.object({
  mutantId: z.coerce.number().int().positive(),
  action: reviewActionSchema,
  comment: optionalText(LIMITS.reviewComment),
  duplicateOfId: optionalNumber(z.coerce.number().int().positive()),
});

export type ReviewMutantInput = z.infer<typeof reviewMutantSchema>;

export const changeMutationStatusSchema = z.object({
  mutantId: z.coerce.number().int().positive(),
  status: mutationStatusSchema,
  comment: optionalText(LIMITS.reviewComment),
});

export type ChangeMutationStatusInput = z.infer<typeof changeMutationStatusSchema>;

export const createValidationSchema = z.object({
  mutantId: z.coerce.number().int().positive(),
  result: validationResultSchema,
  command: optionalText(LIMITS.command),
  environment: optionalText(LIMITS.environment),
  notes: optionalText(LIMITS.notes),
  /** URL, pull request or test path that kills the mutant. Free text, never executed. */
  killingTestRef: optionalText(LIMITS.killingTestRef),
  /** Commit the reproduction ran against (defaults to the mutant's revision). */
  commitSha: z
    .union([z.literal(""), commitShaSchema])
    .optional()
    .transform((v) => (v ? v.toLowerCase() : undefined)),
  /** Attaches the reproduction to a kill claim (verification at its commit). */
  killClaimId: optionalText(64),
});

export const createKillClaimSchema = z.object({
  mutantId: z.coerce.number().int().positive(),
  reference: trimmed(300).min(1, "Enter a pull request, commit or test path"),
  note: optionalText(LIMITS.reviewComment),
});

export const resolveKillClaimSchema = z.object({
  claimId: z.string().min(1),
  verdict: z.enum(["VERIFIED", "REFUTED"]),
  note: optionalText(LIMITS.reviewComment),
});

export type CreateValidationInput = z.infer<typeof createValidationSchema>;

export const createCommentSchema = z.object({
  mutantId: z.coerce.number().int().positive(),
  body: z.string().trim().min(1, "Comment cannot be empty").max(LIMITS.comment),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const registerProjectSchema = z.object({
  repository: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Use the owner/repository form, e.g. curl/curl"),
});

export type RegisterProjectInput = z.infer<typeof registerProjectSchema>;

export const projectRoleSchema = z.enum(["CONTRIBUTOR", "REVIEWER", "MAINTAINER"]);

export const githubUsernameSchema = z
  .string()
  .trim()
  .regex(/^@?[A-Za-z0-9-]{1,39}$/, "Enter a GitHub username")
  .transform((v) => v.replace(/^@/, "").toLowerCase());

export const addMemberSchema = z.object({
  projectId: z.string().min(1),
  username: githubUsernameSchema,
  role: projectRoleSchema,
});

export const changeMemberRoleSchema = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1),
  role: projectRoleSchema,
});

export const removeMemberSchema = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1),
});

export const createSnapshotSchema = z.object({
  name: trimmed(120).min(3, "Name must have at least 3 characters"),
  description: optionalText(LIMITS.description),
  project: optionalText(200),
  reviewStatus: z
    .union([z.literal(""), reviewStatusSchema])
    .optional()
    .transform((v) => (v ? v : undefined)),
  mutationStatus: z
    .union([z.literal(""), mutationStatusSchema])
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export type CreateSnapshotInput = z.infer<typeof createSnapshotSchema>;

export const trackPullRequestSchema = z.object({
  projectId: z.string().min(1),
  number: z.coerce.number().int().positive().max(9_999_999),
});

const count = z.coerce.number().int().min(0).max(10_000_000);

export const createRunRequestSchema = z.object({
  projectId: z.string().min(1),
  number: z.coerce.number().int().positive().max(9_999_999),
  /** Changed files to focus on; empty means the whole pull request. */
  files: z.array(trimmed(LIMITS.filePath).min(1)).max(200).default([]),
  notes: optionalText(LIMITS.runRequestNotes),
});

export const runRequestIdSchema = z.object({ requestId: z.string().min(1).max(64) });

export const closeRunRequestSchema = runRequestIdSchema.extend({
  outcome: z.enum(["CLOSED", "CANCELLED"]),
  reason: optionalText(LIMITS.reviewComment),
});

export const reportRunSchema = runRequestIdSchema.extend({
  commitSha: commitShaSchema.transform((v) => v.toLowerCase()),
  toolName: trimmed(100).min(1, "Name the tool you ran"),
  toolVersion: optionalText(100),
  command: optionalText(LIMITS.command),
  generated: count,
  killed: count,
  survived: count,
  durationSeconds: optionalNumber(
    z.coerce
      .number()
      .int()
      .min(0)
      .max(30 * 24 * 3600),
  ),
  environment: optionalText(LIMITS.environment),
  notes: optionalText(LIMITS.notes),
});

export type ReportRunInput = z.infer<typeof reportRunSchema>;

export const setProjectActiveSchema = z.object({
  projectId: z.string().min(1),
  isActive: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true"),
});

export const mutantListFilterSchema = z.object({
  project: z.string().trim().max(200).optional(),
  language: z.string().trim().max(50).optional(),
  operator: mutationOperatorSchema.optional(),
  reviewStatus: reviewStatusSchema.optional(),
  mutationStatus: mutationStatusSchema.optional(),
  contributor: z.string().trim().max(100).optional(),
  commit: z.string().trim().max(40).optional(),
  file: z.string().trim().max(LIMITS.filePath).optional(),
  q: z.string().trim().max(LIMITS.searchQuery).optional(),
  /** Import batch id (bulk imports). */
  batch: z.string().trim().max(64).optional(),
  /** Result of the last drift check against the default branch. */
  drift: driftStatusSchema.optional(),
  /**
   * Mutants whose mutation has a newer result at a later commit: "hide" keeps
   * only the latest result per mutation, "only" lists the superseded ones.
   */
  superseded: z.enum(["hide", "only"]).optional(),
  /** Created on or after this day (YYYY-MM-DD, UTC). */
  since: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Created on or before this day (YYYY-MM-DD, UTC). */
  until: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Creation order; newest first when omitted. */
  sort: z.enum(["oldest"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type MutantListFilter = z.infer<typeof mutantListFilterSchema>;

/**
 * Filters for the mutants on a pull request page. Unlike the mutant list,
 * superseded mutants (a newer push has a result for the same mutation) are
 * hidden unless `superseded` is "show" or "only".
 */
export const pullRequestMutantFilterSchema = z.object({
  mutationStatus: mutationStatusSchema.optional(),
  reviewStatus: reviewStatusSchema.optional(),
  file: z.string().trim().max(LIMITS.filePath).optional(),
  superseded: z.enum(["show", "only"]).optional(),
});

export type PullRequestMutantFilter = z.infer<typeof pullRequestMutantFilterSchema>;

export const reviewQueueFilterSchema = z.object({
  project: z.string().trim().max(200).optional(),
  contributor: z.string().trim().max(100).optional(),
  file: z.string().trim().max(LIMITS.filePath).optional(),
  status: reviewStatusSchema.optional(),
  operator: mutationOperatorSchema.optional(),
  since: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  duplicates: z.enum(["only", "hide"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type ReviewQueueFilter = z.infer<typeof reviewQueueFilterSchema>;

/** Turns a Zod error into a `{ field: message }` map for inline form errors. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.map(String).join(".") : "_form";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
