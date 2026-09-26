import { createHash } from "node:crypto";

/**
 * Normalizes a code snippet so that cosmetic differences (indentation,
 * trailing whitespace, CRLF, blank lines) do not produce different fingerprints.
 */
export function normalizeCode(code: string): string {
  return code
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0)
    .join("\n");
}

export interface FingerprintInput {
  projectId: string;
  revisionId: string;
  filePath: string;
  startLine: number;
  originalCode: string;
  mutatedCode: string;
}

/**
 * Length-prefixes every field so that no field content can masquerade as a
 * field boundary (e.g. a file path containing the separator).
 */
function encodeFields(fields: string[]): string {
  return fields.map((f) => `${f.length}:${f}`).join("|");
}

/**
 * Exact fingerprint: same project, revision, file, start line and normalized
 * code pair. Two submissions with the same fingerprint are considered
 * identical mutants. The start line is part of the identity because a file
 * often repeats a statement; within one revision the line is a stable location.
 */
export function computeFingerprint(input: FingerprintInput): string {
  const material = encodeFields([
    input.projectId,
    input.revisionId,
    input.filePath.trim(),
    String(input.startLine),
    normalizeCode(input.originalCode),
    normalizeCode(input.mutatedCode),
  ]);
  return createHash("sha256").update(material).digest("hex");
}

/**
 * Looser fingerprint used for "possible duplicate" hints: ignores the revision
 * and the line, so the same mutation submitted against a newer commit (or at a
 * mistyped line) is surfaced to reviewers.
 */
export function computeSimilarityKey(
  input: Omit<FingerprintInput, "revisionId" | "startLine">,
): string {
  const material = encodeFields([
    input.projectId,
    input.filePath.trim(),
    normalizeCode(input.originalCode),
    normalizeCode(input.mutatedCode),
  ]);
  return createHash("sha256").update(material).digest("hex");
}
