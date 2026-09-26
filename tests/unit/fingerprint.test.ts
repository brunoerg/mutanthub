import { describe, expect, it } from "vitest";
import {
  computeFingerprint,
  computeSimilarityKey,
  normalizeCode,
} from "@/domain/mutants/fingerprint";

const base = {
  projectId: "proj",
  revisionId: "rev",
  filePath: "src/a.c",
  startLine: 10,
  originalCode: "if (x > 1) {",
  mutatedCode: "if (x >= 1) {",
};

describe("normalizeCode", () => {
  it("ignores indentation, trailing whitespace, CRLF and blank lines", () => {
    expect(normalizeCode("  if (x > 1) {  \r\n\r\n\t  return;\n")).toBe("if (x > 1) {\nreturn;");
  });

  it("collapses internal whitespace runs", () => {
    expect(normalizeCode("a   +   b")).toBe("a + b");
  });
});

describe("computeFingerprint", () => {
  it("is stable for the same input", () => {
    expect(computeFingerprint(base)).toBe(computeFingerprint({ ...base }));
    expect(computeFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats cosmetic differences as duplicates", () => {
    const a = computeFingerprint(base);
    const b = computeFingerprint({
      ...base,
      originalCode: "    if (x > 1) {   ",
      mutatedCode: "\tif (x >= 1) {\r\n",
    });
    expect(a).toBe(b);
  });

  it("changes when the revision changes", () => {
    expect(computeFingerprint(base)).not.toBe(computeFingerprint({ ...base, revisionId: "other" }));
  });

  it("changes when the start line changes (repeated statements are distinct mutants)", () => {
    expect(computeFingerprint(base)).not.toBe(computeFingerprint({ ...base, startLine: 11 }));
  });

  it("changes when the file, project or code changes", () => {
    expect(computeFingerprint(base)).not.toBe(computeFingerprint({ ...base, filePath: "src/b.c" }));
    expect(computeFingerprint(base)).not.toBe(computeFingerprint({ ...base, projectId: "p2" }));
    expect(computeFingerprint(base)).not.toBe(
      computeFingerprint({ ...base, mutatedCode: "if (x < 1) {" }),
    );
  });

  it("is not fooled by separator injection", () => {
    const sep = String.fromCharCode(0x1f);
    const a = computeFingerprint({ ...base, filePath: "a", originalCode: `b${sep}c` });
    const b = computeFingerprint({ ...base, filePath: `a${sep}b`, originalCode: "c" });
    expect(a).not.toBe(b);
  });
});

describe("computeSimilarityKey", () => {
  it("ignores the revision and the line", () => {
    const { revisionId: _r, startLine: _l, ...rest } = base;
    void _r;
    void _l;
    expect(computeSimilarityKey(rest)).toBe(computeSimilarityKey({ ...rest }));
    expect(computeSimilarityKey(rest)).not.toBe(computeFingerprint(base));
  });
});
