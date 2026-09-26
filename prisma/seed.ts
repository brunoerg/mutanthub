/**
 * Development seed: 3 projects (matching the GitHub fixtures), 8 users,
 * 33 mutants, ~20 validations, ~20 comments, full status history and activity.
 *
 * Run with `npm run db:seed` (or automatically by `prisma migrate reset`).
 * The script is idempotent: it wipes the domain tables before inserting.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import type {
  GlobalRole,
  MutationOperator,
  MutationStatus,
  ObservedResult,
  ProjectRole,
  ReviewStatus,
  ValidationResult,
} from "../src/generated/prisma/enums";
import { MOCK_REPOS, headCommit } from "../src/server/github/fixtures/manifest";
import { computeFingerprint } from "../src/domain/mutants/fingerprint";
import { generateUnifiedDiff } from "../src/domain/mutants/diff";
import { buildNotifications } from "../src/domain/notifications/build";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const FIXTURES_DIR = path.join(process.cwd(), "src/server/github/fixtures/repos");
const OVERLAYS_DIR = path.join(process.cwd(), "src/server/github/fixtures/overlays");

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

interface SeedUser {
  username: string;
  displayName: string;
  globalRole?: GlobalRole;
  bio?: string;
}

const USERS: SeedUser[] = [
  {
    username: "bruno",
    displayName: "Bruno Gomes",
    globalRole: "ADMIN",
    bio: "Platform admin. Mutation testing researcher.",
  },
  {
    username: "alice",
    displayName: "Alice Moreau",
    bio: "Consensus code reviewer, C++ enthusiast.",
  },
  { username: "bob", displayName: "Bob Tanaka", bio: "Maintains the bitcoin catalogue." },
  { username: "carol", displayName: "Carol Singh", bio: "LLVM contributor and compiler tester." },
  { username: "dave", displayName: "Dave Okafor", bio: "Fuzzing all the things." },
  { username: "erin", displayName: "Erin Kowalski" },
  { username: "frank", displayName: "Frank Liu" },
  { username: "grace", displayName: "Grace Hopper-Nguyen" },
];

/** [project index, username, role] */
const MEMBERSHIPS: Array<[number, string, ProjectRole]> = [
  [0, "bob", "MAINTAINER"],
  [0, "alice", "REVIEWER"],
  [0, "dave", "CONTRIBUTOR"],
  [1, "alice", "MAINTAINER"],
  [1, "erin", "REVIEWER"],
  [1, "frank", "CONTRIBUTOR"],
  [2, "carol", "MAINTAINER"],
  [2, "grace", "REVIEWER"],
  [2, "dave", "CONTRIBUTOR"],
];

// ---------------------------------------------------------------------------
// Mutants
// ---------------------------------------------------------------------------

interface SeedValidation {
  by: string;
  result: ValidationResult;
  notes?: string;
  killingTestRef?: string;
  daysAfter: number;
}

interface SeedComment {
  by: string;
  body: string;
  daysAfter: number;
}

interface SeedMutant {
  project: number;
  /** 0 = older commit, 1 = head commit */
  commit: 0 | 1;
  file: string;
  line: number;
  from: string;
  to: string;
  operator: MutationOperator;
  title: string;
  description?: string;
  by: string;
  observed: ObservedResult;
  review: ReviewStatus;
  mutation: MutationStatus;
  reviewedBy?: string;
  reviewComment?: string;
  /** Present when the submitter withdrew the mutant (review must be WITHDRAWN). */
  withdrawReason?: string;
  mutationChangedBy?: string;
  mutationComment?: string;
  duplicateOfIndex?: number;
  daysAgo: number;
  validations?: SeedValidation[];
  comments?: SeedComment[];
  build?: string;
  test?: string;
  fuzz?: string;
  durationSeconds?: number;
  env?: string;
  os?: string;
  compiler?: string;
}

const BTC_BUILD = "cmake -B build -DBUILD_TESTS=ON && cmake --build build -j$(nproc)";
const BTC_TEST = "ctest --test-dir build --output-on-failure";
const CURL_BUILD = "autoreconf -fi && ./configure --with-openssl --enable-debug && make -j$(nproc)";
const CURL_TEST = "make test-ci";
const LLVM_BUILD =
  "cmake -S llvm -B build -G Ninja -DLLVM_ENABLE_PROJECTS=clang -DCMAKE_BUILD_TYPE=Release && ninja -C build";
const LLVM_TEST = "ninja -C build check-llvm-unit check-clang-unit";

const MUTANTS: SeedMutant[] = [
  // ---------------- bitcoin/bitcoin ----------------
  {
    project: 0,
    commit: 1,
    file: "src/script/interpreter.cpp",
    line: 60,
    from: "data.size() <= 75",
    to: "data.size() < 75",
    operator: "RELATIONAL_OPERATOR",
    title: "Off-by-one in minimal push boundary (75 bytes)",
    description:
      "Changes the boundary of the direct-push size check. A 75-byte push would now be expected to use OP_PUSHDATA1.",
    by: "alice",
    observed: "SURVIVED",
    review: "APPROVED",
    mutation: "SURVIVED",
    reviewedBy: "bob",
    reviewComment: "Reproduced locally, boundary is not covered by script_tests.",
    daysAgo: 30,
    validations: [
      {
        by: "dave",
        result: "SURVIVED",
        daysAfter: 1,
        notes: "Full test suite passes with the mutant applied.",
      },
      { by: "erin", result: "SURVIVED", daysAfter: 2 },
      { by: "frank", result: "SURVIVED", daysAfter: 5 },
      { by: "grace", result: "SURVIVED", daysAfter: 9 },
    ],
    comments: [
      {
        by: "dave",
        body: "Confirmed. No vector in `script_tests.json` pushes exactly 75 bytes with the MINIMALDATA flag.",
        daysAfter: 1,
      },
      {
        by: "bob",
        body: "Good catch. A dedicated boundary test for 75 and 76 bytes would kill this. Happy to review a PR upstream.",
        daysAfter: 3,
      },
    ],
  },
  {
    project: 0,
    commit: 1,
    file: "src/script/interpreter.cpp",
    line: 54,
    from: "data[0] <= 16",
    to: "data[0] <= 17",
    operator: "CONSTANT_REPLACEMENT",
    title: "Accept 17 as a small-integer push",
    by: "dave",
    observed: "KILLED",
    review: "APPROVED",
    mutation: "KILLED",
    reviewedBy: "alice",
    daysAgo: 28,
    validations: [
      {
        by: "alice",
        result: "KILLED",
        daysAfter: 1,
        notes: "script_tests: MINIMALDATA vectors fail as expected.",
      },
    ],
  },
  {
    project: 0,
    commit: 1,
    file: "src/script/interpreter.cpp",
    line: 165,
    from: "++nOpCount > MAX_OPS_PER_SCRIPT",
    to: "++nOpCount >= MAX_OPS_PER_SCRIPT",
    operator: "RELATIONAL_OPERATOR",
    title: "Op count limit rejects exactly MAX_OPS_PER_SCRIPT operations",
    by: "alice",
    observed: "SURVIVED",
    review: "APPROVED",
    mutation: "SURVIVED",
    reviewedBy: "bob",
    daysAgo: 25,
    validations: [
      { by: "dave", result: "SURVIVED", daysAfter: 2 },
      {
        by: "bruno",
        result: "KILLED",
        daysAfter: 6,
        notes:
          "Fails `script_tests` when run with the newer test vectors from master. Possibly test data drift.",
      },
    ],
    comments: [
      {
        by: "bruno",
        body: "I get a **killed** result here. Are you running the test vectors from the same commit? The mutant was submitted against an older revision.",
        daysAfter: 6,
      },
      { by: "alice", body: "Yes, same commit. Let me re-run in a clean checkout.", daysAfter: 7 },
    ],
  },
  {
    project: 0,
    commit: 1,
    file: "src/script/interpreter.cpp",
    line: 305,
    from: "stack.size() != 1",
    to: "stack.size() < 1",
    operator: "RELATIONAL_OPERATOR",
    title: "Allow extra stack elements at end of script evaluation",
    by: "frank",
    observed: "KILLED",
    review: "APPROVED",
    mutation: "KILLED",
    reviewedBy: "alice",
    daysAgo: 22,
    validations: [
      { by: "dave", result: "KILLED", daysAfter: 1 },
      { by: "erin", result: "KILLED", daysAfter: 3 },
    ],
  },
  {
    project: 0,
    commit: 1,
    file: "src/script/interpreter.cpp",
    line: 38,
    from: "vch[i] == 0x80",
    to: "vch[i] == 0x00",
    operator: "CONSTANT_REPLACEMENT",
    title: "Negative zero is no longer treated as false in CastToBool",
    by: "erin",
    observed: "SURVIVED",
    review: "PENDING",
    mutation: "SURVIVED",
    daysAgo: 2,
    validations: [{ by: "dave", result: "SURVIVED", daysAfter: 1 }],
  },
  {
    project: 0,
    commit: 1,
    file: "src/consensus/tx_verify.cpp",
    line: 44,
    from: "txout.nValue > MAX_MONEY",
    to: "txout.nValue >= MAX_MONEY",
    operator: "RELATIONAL_OPERATOR",
    title: "Reject outputs equal to MAX_MONEY",
    by: "dave",
    observed: "KILLED",
    review: "APPROVED",
    mutation: "KILLED",
    reviewedBy: "bob",
    daysAgo: 20,
  },
  {
    project: 0,
    commit: 1,
    file: "src/consensus/tx_verify.cpp",
    line: 62,
    from: "scriptSig.size() > 100",
    to: "scriptSig.size() > 101",
    operator: "CONSTANT_REPLACEMENT",
    title: "Coinbase scriptSig upper bound off by one",
    by: "grace",
    observed: "SURVIVED",
    review: "APPROVED",
    mutation: "SURVIVED",
    reviewedBy: "alice",
    daysAgo: 18,
    validations: [
      { by: "bob", result: "SURVIVED", daysAfter: 1 },
      { by: "frank", result: "SURVIVED", daysAfter: 2 },
    ],
    comments: [
      {
        by: "grace",
        body: "The 100-byte coinbase limit is only checked in `CheckTransaction`; no unit test builds a 101-byte scriptSig.",
        daysAfter: 0,
      },
    ],
  },
  {
    project: 0,
    commit: 1,
    file: "src/consensus/tx_verify.cpp",
    line: 82,
    from: "tx.nLockTime) < threshold",
    to: "tx.nLockTime) <= threshold",
    operator: "RELATIONAL_OPERATOR",
    title: "IsFinalTx treats lock time equal to threshold as final",
    by: "alice",
    observed: "SURVIVED",
    review: "NEEDS_INFORMATION",
    mutation: "SURVIVED",
    reviewedBy: "bob",
    reviewComment:
      "Please attach the ctest output; the description says the suite passed but the duration looks too short for a full run.",
    daysAgo: 4,
  },
  {
    project: 0,
    commit: 1,
    file: "src/util/strencodings.cpp",
    line: 64,
    from: "str.size() % 2 == 0",
    to: "str.size() % 2 == 1",
    operator: "CONSTANT_REPLACEMENT",
    title: "IsHex accepts odd-length strings",
    by: "frank",
    observed: "KILLED",
    review: "APPROVED",
    mutation: "KILLED",
    reviewedBy: "alice",
    daysAgo: 17,
    validations: [{ by: "dave", result: "KILLED", daysAfter: 1 }],
  },
  {
    project: 0,
    commit: 1,
    file: "src/util/strencodings.cpp",
    line: 141,
    from: "padding > 2",
    to: "padding > 3",
    operator: "CONSTANT_REPLACEMENT",
    title: "Base64 decoder accepts three padding characters",
    by: "erin",
    observed: "SURVIVED",
    review: "APPROVED",
    mutation: "SURVIVED",
    reviewedBy: "bob",
    daysAgo: 15,
    validations: [
      {
        by: "grace",
        result: "COULD_NOT_REPRODUCE",
        daysAfter: 2,
        notes: "Build failed on macOS with clang 19; unrelated to the mutant.",
      },
    ],
  },
  {
    project: 0,
    commit: 1,
    file: "src/util/strencodings.cpp",
    line: 153,
    from: "end - front + 1",
    to: "end - front",
    operator: "ARITHMETIC_OPERATOR",
    title: "TrimString drops the last character",
    by: "dave",
    observed: "KILLED",
    review: "REJECTED",
    mutation: "KILLED",
    reviewedBy: "alice",
    reviewComment:
      "Killed mutants that are trivially covered are out of scope for the catalogue; see contribution guide.",
    daysAgo: 14,
  },
  {
    project: 0,
    commit: 1,
    file: "src/validation.cpp",
    line: 138,
    from: "nAdjustedTime + MAX_FUTURE_BLOCK_TIME",
    to: "nAdjustedTime + MAX_FUTURE_BLOCK_TIME + 1",
    operator: "ARITHMETIC_OPERATOR",
    title: "Accept blocks one second further into the future",
    by: "alice",
    observed: "SURVIVED",
    review: "APPROVED",
    mutation: "EQUIVALENT",
    reviewedBy: "bob",
    mutationChangedBy: "bob",
    mutationComment:
      "Block timestamps have one-second granularity and the comparison is strict; the mutated bound is unreachable in practice. Classified as equivalent after discussion.",
    daysAgo: 27,
    validations: [
      { by: "dave", result: "SURVIVED", daysAfter: 1 },
      { by: "erin", result: "SURVIVED", daysAfter: 2 },
    ],
    comments: [
      {
        by: "bob",
        body: "I believe this is equivalent: `GetBlockTime()` is an integer number of seconds so `> t + 7200` and `> t + 7201` differ only for exactly `t + 7201`, which the strict check already handles the same way... let me double check.",
        daysAfter: 2,
      },
      {
        by: "alice",
        body: "They do differ for exactly `t + 7201`. But `nAdjustedTime` is itself clamped by `MAX_FUTURE_BLOCK_TIME` in the caller, so the extra second is never observable.",
        daysAfter: 3,
      },
      { by: "bob", body: "Agreed, marking as equivalent.", daysAfter: 4 },
    ],
  },
  {
    project: 0,
    commit: 1,
    file: "src/validation.cpp",
    line: 154,
    from: ">= COINBASE_MATURITY",
    to: "> COINBASE_MATURITY",
    operator: "RELATIONAL_OPERATOR",
    title: "Coinbase requires one extra confirmation to be spendable",
    by: "grace",
    observed: "KILLED",
    review: "APPROVED",
    mutation: "KILLED",
    reviewedBy: "alice",
    daysAgo: 12,
    validations: [{ by: "frank", result: "KILLED", daysAfter: 1 }],
  },
  {
    project: 0,
    commit: 0,
    file: "src/validation.cpp",
    line: 23,
    from: "halvings >= 64",
    to: "halvings > 64",
    operator: "RELATIONAL_OPERATOR",
    title: "Subsidy shift by 64 is no longer guarded",
    description:
      "Submitted against the older revision on purpose: the surrounding code was refactored later.",
    by: "bob",
    observed: "SURVIVED",
    review: "APPROVED",
    mutation: "SURVIVED",
    reviewedBy: "alice",
    daysAgo: 40,
    validations: [{ by: "dave", result: "SURVIVED", daysAfter: 3 }],
    comments: [
      {
        by: "carol",
        body: "Note this refers to the older commit. On the current head the function moved; a rebase would be needed to reproduce there.",
        daysAfter: 20,
      },
    ],
  },
  {
    project: 0,
    commit: 1,
    file: "src/script/interpreter.cpp",
    line: 60,
    from: "data.size() <= 75",
    to: "data.size() < 75",
    operator: "RELATIONAL_OPERATOR",
    title: "Minimal push 75-byte boundary",
    by: "frank",
    observed: "SURVIVED",
    review: "DUPLICATE",
    mutation: "SURVIVED",
    reviewedBy: "bob",
    reviewComment: "Same change as #1.",
    duplicateOfIndex: 0,
    daysAgo: 6,
  },
  // ---------------- curl/curl ----------------
  {
    project: 1,
    commit: 1,
    file: "lib/url.c",
    line: 117,
    from: "value > MAX_PORT",
    to: "value >= MAX_PORT",
    operator: "RELATIONAL_OPERATOR",
    title: "Port 65535 is rejected",
    by: "frank",
    observed: "SURVIVED",
    review: "APPROVED",
    mutation: "SURVIVED",
    reviewedBy: "alice",
    daysAgo: 24,
    build: CURL_BUILD,
    test: CURL_TEST,
    durationSeconds: 1450,
    env: "Ubuntu 24.04, gcc 14.2, OpenSSL 3.3",
    os: "Linux",
    compiler: "gcc 14.2",
    validations: [
      { by: "erin", result: "SURVIVED", daysAfter: 1 },
      { by: "dave", result: "SURVIVED", daysAfter: 4 },
      { by: "grace", result: "SURVIVED", daysAfter: 8 },
    ],
    comments: [
      {
        by: "erin",
        body: "Test 1560 (URL API) covers ports > 65535 but not the exact maximum. Adding `http://example.com:65535/` to the unit test would kill this.",
        daysAfter: 1,
      },
    ],
  },
  {
    project: 1,
    commit: 1,
    file: "lib/url.c",
    line: 120,
    from: "digits > 5",
    to: "digits > 6",
    operator: "CONSTANT_REPLACEMENT",
    title: "Allow six-digit port strings",
    by: "erin",
    observed: "KILLED",
    review: "APPROVED",
    mutation: "KILLED",
    reviewedBy: "alice",
    daysAgo: 23,
    build: CURL_BUILD,
    test: CURL_TEST,
    env: "Debian 12, clang 17",
    os: "Linux",
    compiler: "clang 17",
  },
  {
    project: 1,
    commit: 1,
    file: "lib/url.c",
    line: 175,
    from: "len + 1 > hostlen",
    to: "len > hostlen",
    operator: "ARITHMETIC_OPERATOR",
    title: "Host buffer bound check ignores the terminator",
    by: "dave",
    observed: "SURVIVED",
    review: "APPROVED",
    mutation: "SURVIVED",
    reviewedBy: "erin",
    daysAgo: 19,
    build: CURL_BUILD,
    test: CURL_TEST,
    fuzz: "./curl_fuzzer -max_total_time=600 corpus/",
    durationSeconds: 2100,
    env: "Fedora 40, gcc 14, ASan enabled",
    os: "Linux",
    compiler: "gcc 14",
    validations: [
      { by: "frank", result: "SURVIVED", daysAfter: 2, notes: "Also survives with ASan/UBSan." },
    ],
    comments: [
      {
        by: "alice",
        body: "This one is interesting from a memory-safety angle. Even if the tests pass, a fuzz target exercising `parse_hostname` with a full-length host should catch it.",
        daysAfter: 2,
      },
    ],
  },
  {
    project: 1,
    commit: 1,
    file: "lib/url.c",
    line: 206,
    from: "c >= 0x80",
    to: "c > 0x80",
    operator: "RELATIONAL_OPERATOR",
    title: "Byte 0x80 is treated as ASCII",
    by: "grace",
    observed: "SURVIVED",
    review: "PENDING",
    mutation: "SURVIVED",
    daysAgo: 1,
    build: CURL_BUILD,
    test: CURL_TEST,
    env: "macOS 15, Apple clang 16",
    os: "macOS",
    compiler: "Apple clang 16",
  },
  {
    project: 1,
    commit: 1,
    file: "lib/escape.c",
    line: 62,
    from: "c >= 'a' && c <= 'f'",
    to: "c >= 'a' && c < 'f'",
    operator: "RELATIONAL_OPERATOR",
    title: "Hex digit 'f' is not decoded",
    by: "alice",
    observed: "KILLED",
    review: "APPROVED",
    mutation: "KILLED",
    reviewedBy: "erin",
    daysAgo: 16,
    build: CURL_BUILD,
    test: CURL_TEST,
    env: "Ubuntu 24.04, gcc 14",
    os: "Linux",
    compiler: "gcc 14",
    validations: [{ by: "dave", result: "KILLED", daysAfter: 1 }],
  },
  {
    project: 1,
    commit: 1,
    file: "lib/escape.c",
    line: 87,
    from: "length * 3 + 1",
    to: "length * 3 + 2",
    operator: "CONSTANT_REPLACEMENT",
    title: "Over-allocate escape buffer by one byte",
    by: "frank",
    observed: "SURVIVED",
    review: "APPROVED",
    mutation: "EQUIVALENT",
    reviewedBy: "alice",
    mutationChangedBy: "alice",
    mutationComment:
      "Allocating one extra byte has no observable behaviour; equivalent by construction.",
    daysAgo: 21,
    build: CURL_BUILD,
    test: CURL_TEST,
    env: "Ubuntu 24.04, gcc 14",
    os: "Linux",
    compiler: "gcc 14",
    comments: [
      {
        by: "alice",
        body: "Equivalent: a larger allocation cannot change the output. Marking accordingly so it is excluded from mutation score computations.",
        daysAfter: 1,
      },
    ],
  },
  {
    project: 1,
    commit: 1,
    file: "lib/escape.c",
    line: 139,
    from: "in == 0x7f",
    to: "in == 0x7e",
    operator: "CONSTANT_REPLACEMENT",
    title: "DEL is no longer rejected as a control character",
    by: "erin",
    observed: "SURVIVED",
    review: "APPROVED",
    mutation: "KILLED",
    reviewedBy: "alice",
    mutationChangedBy: "erin",
    mutationComment: "Killed by the new unit test added upstream in tests/unit/unit1300.c.",
    daysAgo: 26,
    build: CURL_BUILD,
    test: CURL_TEST,
    env: "Ubuntu 24.04, gcc 14",
    os: "Linux",
    compiler: "gcc 14",
    validations: [
      { by: "dave", result: "SURVIVED", daysAfter: 1 },
      {
        by: "grace",
        result: "KILLED",
        daysAfter: 12,
        notes: "With the new unit test the mutant fails immediately.",
        killingTestRef: "https://github.com/curl/curl/pull/18877 (tests/unit/unit1300.c)",
      },
    ],
    comments: [
      {
        by: "grace",
        body: "I wrote a test that feeds `\\x7f` to `curl_easy_unescape` with `reject_ctrl` set. It kills this mutant. Opened a PR upstream.",
        daysAfter: 11,
      },
      {
        by: "erin",
        body: "Excellent. Updating the mutation status to killed and linking the test.",
        daysAfter: 12,
      },
    ],
  },
  {
    project: 1,
    commit: 1,
    file: "lib/parsedate.c",
    line: 285,
    from: "yearnum > 2037",
    to: "yearnum > 2038",
    operator: "CONSTANT_REPLACEMENT",
    title: "Year 2038 accepted by the date parser",
    by: "dave",
    observed: "SURVIVED",
    review: "APPROVED",
    mutation: "SURVIVED",
    reviewedBy: "erin",
    daysAgo: 11,
    build: CURL_BUILD,
    test: "make -C tests unit && ./tests/unit/unit1300",
    env: "Arch Linux, gcc 14.2",
    os: "Linux",
    compiler: "gcc 14.2",
    validations: [
      { by: "frank", result: "SURVIVED", daysAfter: 1 },
      { by: "alice", result: "SURVIVED", daysAfter: 3 },
    ],
  },
  {
    project: 1,
    commit: 1,
    file: "lib/parsedate.c",
    line: 251,
    from: "(val < 32)",
    to: "(val <= 32)",
    operator: "RELATIONAL_OPERATOR",
    title: "Day-of-month 32 accepted",
    by: "grace",
    observed: "KILLED",
    review: "REJECTED",
    mutation: "INVALID",
    reviewedBy: "alice",
    reviewComment:
      "The diff does not apply to the referenced commit (context lines differ). Please regenerate it.",
    mutationChangedBy: "alice",
    mutationComment: "Patch does not apply cleanly.",
    daysAgo: 9,
    build: CURL_BUILD,
    test: CURL_TEST,
    env: "Windows 11, MSVC 19.40",
    os: "Windows",
    compiler: "MSVC 19.40",
  },
  {
    project: 1,
    commit: 1,
    file: "lib/http.c",
    line: 49,
    from: "minor < 0 || minor > 1",
    to: "minor < 0 || minor > 2",
    operator: "CONSTANT_REPLACEMENT",
    title: "Accept HTTP/1.2 status lines",
    by: "alice",
    observed: "SURVIVED",
    review: "APPROVED",
    mutation: "SURVIVED",
    reviewedBy: "erin",
    daysAgo: 8,
    build: CURL_BUILD,
    test: CURL_TEST,
    env: "Ubuntu 24.04, gcc 14",
    os: "Linux",
    compiler: "gcc 14",
    validations: [{ by: "dave", result: "SURVIVED", daysAfter: 1 }],
    comments: [
      {
        by: "dave",
        body: "Survives. There is no test with a malformed minor version. Worth adding to test1130-style checks.",
        daysAfter: 1,
      },
    ],
  },
  {
    project: 1,
    commit: 1,
    file: "lib/http.c",
    line: 152,
    from: "i == 0 || i > 16",
    to: "i == 0 && i > 16",
    operator: "LOGICAL_OPERATOR",
    title: "Chunk size length check becomes unreachable",
    by: "frank",
    observed: "SURVIVED",
    review: "PENDING",
    mutation: "SURVIVED",
    daysAgo: 3,
    build: CURL_BUILD,
    test: CURL_TEST,
    env: "Ubuntu 24.04, gcc 14",
    os: "Linux",
    compiler: "gcc 14",
  },
  // ---------------- llvm/llvm-project ----------------
  {
    project: 2,
    commit: 1,
    file: "llvm/lib/Support/APInt.cpp",
    line: 150,
    from: "countPopulation() == 1",
    to: "countPopulation() <= 1",
    operator: "RELATIONAL_OPERATOR",
    title: "Zero is reported as a power of two",
    by: "carol",
    observed: "KILLED",
    review: "APPROVED",
    mutation: "KILLED",
    reviewedBy: "grace",
    daysAgo: 29,
    build: LLVM_BUILD,
    test: LLVM_TEST,
    durationSeconds: 5400,
    env: "Ubuntu 24.04, clang 18, ninja",
    os: "Linux",
    compiler: "clang 18",
    validations: [{ by: "dave", result: "KILLED", daysAfter: 2 }],
  },
  {
    project: 2,
    commit: 1,
    file: "llvm/lib/Support/APInt.cpp",
    line: 173,
    from: "LhsBits < RhsBits",
    to: "LhsBits <= RhsBits",
    operator: "RELATIONAL_OPERATOR",
    title: "Unsigned comparison with equal bit lengths short-circuits",
    by: "dave",
    observed: "SURVIVED",
    review: "APPROVED",
    mutation: "SURVIVED",
    reviewedBy: "carol",
    daysAgo: 13,
    build: LLVM_BUILD,
    test: "ninja -C build check-llvm-unit",
    durationSeconds: 3900,
    env: "Ubuntu 24.04, clang 18",
    os: "Linux",
    compiler: "clang 18",
    validations: [
      { by: "grace", result: "SURVIVED", daysAfter: 1 },
      {
        by: "carol",
        result: "COULD_NOT_REPRODUCE",
        daysAfter: 2,
        notes: "Ran out of disk space during the build; will retry.",
      },
    ],
    comments: [
      {
        by: "carol",
        body: "APIntTest has `CompareWithDifferentWidths` but every case uses strictly different widths. A same-width case with different magnitudes would cover this.",
        daysAfter: 1,
      },
    ],
  },
  {
    project: 2,
    commit: 1,
    file: "llvm/lib/Support/StringRef.cpp",
    line: 95,
    from: "N > size() - From",
    to: "N >= size() - From",
    operator: "RELATIONAL_OPERATOR",
    title: "substr clamps one character early",
    by: "grace",
    observed: "KILLED",
    review: "APPROVED",
    mutation: "KILLED",
    reviewedBy: "carol",
    daysAgo: 10,
    build: LLVM_BUILD,
    test: "ninja -C build check-llvm-unit",
    env: "Ubuntu 24.04, clang 18",
    os: "Linux",
    compiler: "clang 18",
  },
  {
    project: 2,
    commit: 1,
    file: "llvm/lib/Analysis/ValueTracking.cpp",
    line: 52,
    from: "Depth >= MaxAnalysisRecursionDepth",
    to: "Depth > MaxAnalysisRecursionDepth",
    operator: "RELATIONAL_OPERATOR",
    title: "Allow one extra level of analysis recursion",
    by: "dave",
    observed: "SURVIVED",
    review: "APPROVED",
    mutation: "SURVIVED",
    reviewedBy: "grace",
    daysAgo: 7,
    build: LLVM_BUILD,
    test: LLVM_TEST,
    durationSeconds: 6100,
    env: "Ubuntu 24.04, clang 18",
    os: "Linux",
    compiler: "clang 18",
    validations: [{ by: "carol", result: "SURVIVED", daysAfter: 2 }],
    comments: [
      {
        by: "carol",
        body: "Likely killable but expensive: it needs an IR test with a chain deeper than the recursion limit.",
        daysAfter: 2,
      },
    ],
  },
  {
    project: 2,
    commit: 1,
    file: "clang/lib/Lex/Lexer.cpp",
    line: 30,
    from: "(C >= '0' && C <= '9')",
    to: "(C >= '0' && C < '9')",
    operator: "RELATIONAL_OPERATOR",
    title: "Digit 9 not accepted in identifier body",
    by: "carol",
    observed: "KILLED",
    review: "APPROVED",
    mutation: "KILLED",
    reviewedBy: "grace",
    daysAgo: 5,
    build: LLVM_BUILD,
    test: "ninja -C build check-clang-unit",
    env: "Ubuntu 24.04, clang 18",
    os: "Linux",
    compiler: "clang 18",
    validations: [{ by: "dave", result: "KILLED", daysAfter: 1 }],
  },
  {
    project: 2,
    commit: 1,
    file: "llvm/lib/Support/StringRef.cpp",
    line: 177,
    from: "Consumed == 0",
    to: "Consumed <= 0",
    operator: "RELATIONAL_OPERATOR",
    title: "getAsInteger accepts zero consumed characters",
    by: "dave",
    observed: "SURVIVED",
    review: "WITHDRAWN",
    mutation: "SURVIVED",
    withdrawReason:
      "Withdrawn: Consumed is unsigned, so `<= 0` and `== 0` are the same predicate. This is equivalent by construction, not a test gap.",
    daysAgo: 6,
    build: LLVM_BUILD,
    test: "ninja -C build check-llvm-unit",
    env: "Ubuntu 24.04, clang 18",
    os: "Linux",
    compiler: "clang 18",
  },
  {
    project: 2,
    commit: 1,
    file: "clang/lib/Lex/Lexer.cpp",
    line: 107,
    from: "Length > MaxIdentifierLength",
    to: "Length > MaxIdentifierLength + 1",
    operator: "ARITHMETIC_OPERATOR",
    title: "Identifier length limit off by one",
    by: "grace",
    observed: "SURVIVED",
    review: "NEEDS_INFORMATION",
    mutation: "SURVIVED",
    reviewedBy: "carol",
    reviewComment:
      "Which check-* target did you run? The lexer unit tests live in check-clang-unit.",
    daysAgo: 2,
    build: LLVM_BUILD,
    test: "ninja -C build check-llvm-unit",
    env: "Ubuntu 24.04, clang 18",
    os: "Linux",
    compiler: "clang 18",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fileCache = new Map<string, string[]>();

/** Mirrors the mock client: a commit with its own copy of the file wins. */
async function fixtureLines(
  owner: string,
  repo: string,
  file: string,
  sha: string,
): Promise<string[]> {
  const key = `${owner}/${repo}/${sha}/${file}`;
  const cached = fileCache.get(key);
  if (cached) return cached;
  const content = await readFile(path.join(OVERLAYS_DIR, owner, repo, sha, file), "utf8").catch(
    () => readFile(path.join(FIXTURES_DIR, owner, repo, file), "utf8"),
  );
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  fileCache.set(key, lines);
  return lines;
}

function daysAgo(days: number, hourOffset = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(9 + hourOffset, 0, 0, 0);
  return d;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Clearing existing data...");
  await prisma.notification.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.mutantStatusHistory.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.validation.deleteMany();
  await prisma.submission.deleteMany();
  await prisma.mutant.deleteMany();
  await prisma.revision.deleteMany();
  await prisma.projectFollow.deleteMany();
  await prisma.projectMember.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();

  console.log("Creating users...");
  const userByName = new Map<string, string>();
  for (const [i, u] of USERS.entries()) {
    const user = await prisma.user.create({
      data: {
        githubUsername: u.username,
        displayName: u.displayName,
        globalRole: u.globalRole ?? "USER",
        avatarUrl: `https://avatars.githubusercontent.com/u/${1000 + i}?v=4`,
        bio: u.bio,
        createdAt: daysAgo(60 - i),
      },
    });
    userByName.set(u.username, user.id);
  }
  const uid = (name: string): string => {
    const id = userByName.get(name);
    if (!id) throw new Error(`Unknown seed user ${name}`);
    return id;
  };

  console.log("Creating projects and revisions...");
  const projects = [];
  const revisionIds: Array<[string, string]> = [];
  for (const mock of MOCK_REPOS) {
    const project = await prisma.project.create({
      data: {
        githubOwner: mock.info.owner,
        githubRepository: mock.info.name,
        githubRepositoryId: mock.info.id,
        displayName: mock.info.fullName,
        description: mock.info.description,
        defaultBranch: mock.info.defaultBranch,
        language: mock.info.language,
        addedById: uid("bruno"),
        createdAt: daysAgo(55),
      },
    });
    projects.push(project);
    const [older, head] = [mock.commits[0], headCommit(mock)];
    const ids: [string, string] = ["", ""];
    for (const [idx, c] of [older, head].entries()) {
      const rev = await prisma.revision.create({
        data: {
          projectId: project.id,
          commitSha: c.sha,
          branch: idx === 1 ? mock.info.defaultBranch : null,
          commitMessage: c.message.split("\n")[0],
          author: c.authorLogin ?? c.authorName,
          commitDate: c.date,
        },
      });
      ids[idx] = rev.id;
    }
    revisionIds.push(ids);
  }

  for (const [projectIndex, username, role] of MEMBERSHIPS) {
    await prisma.projectMember.create({
      data: { projectId: projects[projectIndex].id, userId: uid(username), role },
    });
  }
  for (const [projectIndex, username] of [
    [0, "bruno"],
    [1, "bruno"],
    [2, "bruno"],
    [0, "dave"],
    [1, "frank"],
    [2, "dave"],
    [0, "erin"],
  ] as Array<[number, string]>) {
    await prisma.projectFollow.create({
      data: { projectId: projects[projectIndex].id, userId: uid(username) },
    });
  }

  console.log("Creating mutants...");
  const mutantIds: number[] = [];
  for (const [index, m] of MUTANTS.entries()) {
    const project = projects[m.project];
    const mock = MOCK_REPOS[m.project];
    const revisionId = revisionIds[m.project][m.commit];
    const lines = await fixtureLines(
      mock.info.owner,
      mock.info.name,
      m.file,
      mock.commits[m.commit].sha,
    );
    const original = lines[m.line - 1];
    if (original === undefined) throw new Error(`Line ${m.line} missing in ${m.file}`);
    if (!original.includes(m.from)) {
      throw new Error(
        `Seed mutant #${index + 1}: "${m.from}" not found on ${m.file}:${m.line}\n  line: ${original}`,
      );
    }
    const mutated = original.replace(m.from, m.to);
    const createdAt = daysAgo(m.daysAgo);
    const fingerprint = computeFingerprint({
      projectId: project.id,
      revisionId,
      filePath: m.file,
      startLine: m.line,
      originalCode: original,
      mutatedCode: mutated,
    });
    const gitDiff = generateUnifiedDiff({
      filePath: m.file,
      startLine: m.line,
      originalCode: original,
      mutatedCode: mutated,
    });
    const defaults =
      m.project === 0
        ? {
            build: BTC_BUILD,
            test: BTC_TEST,
            env: "Ubuntu 24.04, gcc 13.2, Boost 1.83",
            os: "Linux",
            compiler: "gcc 13.2",
          }
        : m.project === 1
          ? {
              build: CURL_BUILD,
              test: CURL_TEST,
              env: "Ubuntu 24.04, gcc 14",
              os: "Linux",
              compiler: "gcc 14",
            }
          : {
              build: LLVM_BUILD,
              test: LLVM_TEST,
              env: "Ubuntu 24.04, clang 18",
              os: "Linux",
              compiler: "clang 18",
            };

    const mutant = await prisma.mutant.create({
      data: {
        projectId: project.id,
        revisionId,
        filePath: m.file,
        startLine: m.line,
        endLine: m.line,
        originalCode: original,
        mutatedCode: mutated,
        gitDiff,
        mutationOperator: m.operator,
        title: m.title,
        description: m.description ?? null,
        fingerprint,
        reviewStatus: m.review,
        mutationStatus: m.mutation,
        duplicateOfId: m.duplicateOfIndex !== undefined ? mutantIds[m.duplicateOfIndex] : null,
        createdById: uid(m.by),
        createdAt,
        updatedAt: createdAt,
        submissions: {
          create: {
            submittedById: uid(m.by),
            buildCommand: m.build ?? defaults.build,
            testCommand: m.test ?? defaults.test,
            fuzzCommand: m.fuzz ?? null,
            testDurationSeconds:
              m.durationSeconds ?? (m.project === 2 ? 4800 : 900 + ((index * 37) % 600)),
            environmentDescription: m.env ?? defaults.env,
            operatingSystem: m.os ?? defaults.os,
            compiler: m.compiler ?? defaults.compiler,
            observedResult: m.observed,
            notes:
              m.observed === "SURVIVED"
                ? "All tests passed with the patch applied."
                : m.observed === "KILLED"
                  ? "At least one test failed with the patch applied."
                  : null,
            createdAt,
          },
        },
      },
    });
    mutantIds.push(mutant.id);

    // Initial history + submission activity
    await prisma.mutantStatusHistory.createMany({
      data: [
        {
          mutantId: mutant.id,
          kind: "REVIEW",
          previousValue: null,
          newValue: "PENDING",
          changedById: uid(m.by),
          createdAt,
        },
        {
          mutantId: mutant.id,
          kind: "MUTATION",
          previousValue: null,
          newValue: m.observed,
          changedById: uid(m.by),
          comment: "Initial result reported by the submitter",
          createdAt,
        },
      ],
    });
    await prisma.activity.create({
      data: {
        type: "MUTANT_SUBMITTED",
        actorId: uid(m.by),
        projectId: project.id,
        mutantId: mutant.id,
        payload: { title: m.title, filePath: m.file, startLine: m.line },
        createdAt,
      },
    });

    // Review transition
    if (m.review !== "PENDING" && m.reviewedBy) {
      const at = daysAgo(m.daysAgo, 5);
      await prisma.mutantStatusHistory.create({
        data: {
          mutantId: mutant.id,
          kind: "REVIEW",
          previousValue: "PENDING",
          newValue: m.review,
          changedById: uid(m.reviewedBy),
          comment: m.reviewComment ?? null,
          createdAt: at,
        },
      });
      const type =
        m.review === "APPROVED"
          ? "MUTANT_APPROVED"
          : m.review === "REJECTED"
            ? "MUTANT_REJECTED"
            : m.review === "DUPLICATE"
              ? "MUTANT_MARKED_DUPLICATE"
              : "MUTANT_NEEDS_INFORMATION";
      await prisma.activity.create({
        data: {
          type,
          actorId: uid(m.reviewedBy),
          projectId: project.id,
          mutantId: mutant.id,
          payload: {
            kind: "REVIEW",
            from: "PENDING",
            to: m.review,
            comment: m.reviewComment ?? null,
          },
          createdAt: at,
        },
      });
    }

    // Submitter withdrawal
    if (m.review === "WITHDRAWN") {
      const at = daysAgo(Math.max(0, m.daysAgo - 1), 6);
      await prisma.mutantStatusHistory.create({
        data: {
          mutantId: mutant.id,
          kind: "REVIEW",
          previousValue: "PENDING",
          newValue: "WITHDRAWN",
          changedById: uid(m.by),
          comment: m.withdrawReason ?? null,
          createdAt: at,
        },
      });
      await prisma.activity.create({
        data: {
          type: "MUTANT_WITHDRAWN",
          actorId: uid(m.by),
          projectId: project.id,
          mutantId: mutant.id,
          payload: {
            kind: "REVIEW",
            from: "PENDING",
            to: "WITHDRAWN",
            comment: m.withdrawReason ?? null,
          },
          createdAt: at,
        },
      });
    }

    // Mutation status transition (e.g. SURVIVED -> EQUIVALENT / KILLED / INVALID)
    if (m.mutation !== m.observed && m.mutationChangedBy) {
      const at = daysAgo(Math.max(0, m.daysAgo - 4), 3);
      await prisma.mutantStatusHistory.create({
        data: {
          mutantId: mutant.id,
          kind: "MUTATION",
          previousValue: m.observed,
          newValue: m.mutation,
          changedById: uid(m.mutationChangedBy),
          comment: m.mutationComment ?? null,
          createdAt: at,
        },
      });
      const type =
        m.mutation === "KILLED"
          ? "MUTANT_KILLED"
          : m.mutation === "EQUIVALENT"
            ? "MUTANT_MARKED_EQUIVALENT"
            : m.mutation === "INVALID"
              ? "MUTANT_MARKED_INVALID"
              : "MUTANT_STATUS_CHANGED";
      await prisma.activity.create({
        data: {
          type,
          actorId: uid(m.mutationChangedBy),
          projectId: project.id,
          mutantId: mutant.id,
          payload: {
            kind: "MUTATION",
            from: m.observed,
            to: m.mutation,
            comment: m.mutationComment ?? null,
          },
          createdAt: at,
        },
      });
    }

    for (const v of m.validations ?? []) {
      const at = daysAgo(Math.max(0, m.daysAgo - v.daysAfter), 2);
      await prisma.validation.create({
        data: {
          mutantId: mutant.id,
          userId: uid(v.by),
          result: v.result,
          command: `git apply mutant.patch && ${m.test ?? defaults.test}`,
          environment:
            v.by === "grace"
              ? "macOS 15, Apple clang 16"
              : v.by === "bruno"
                ? "NixOS 25.05, gcc 14"
                : defaults.env,
          notes: v.notes ?? null,
          killingTestRef: v.killingTestRef ?? null,
          createdAt: at,
        },
      });
      await prisma.activity.create({
        data: {
          type: "MUTANT_REPRODUCED",
          actorId: uid(v.by),
          projectId: project.id,
          mutantId: mutant.id,
          payload: { result: v.result },
          createdAt: at,
        },
      });
    }

    for (const c of m.comments ?? []) {
      const at = daysAgo(Math.max(0, m.daysAgo - c.daysAfter), 4);
      await prisma.comment.create({
        data: {
          mutantId: mutant.id,
          userId: uid(c.by),
          body: c.body,
          createdAt: at,
          updatedAt: at,
        },
      });
      await prisma.activity.create({
        data: {
          type: "COMMENT_ADDED",
          actorId: uid(c.by),
          projectId: project.id,
          mutantId: mutant.id,
          payload: { excerpt: c.body.slice(0, 140) },
          createdAt: at,
        },
      });
    }
  }

  console.log("Deriving notifications from activity...");
  await seedNotifications();

  const totals = {
    users: await prisma.user.count(),
    projects: await prisma.project.count(),
    mutants: await prisma.mutant.count(),
    validations: await prisma.validation.count(),
    comments: await prisma.comment.count(),
    history: await prisma.mutantStatusHistory.count(),
    activity: await prisma.activity.count(),
    notifications: await prisma.notification.count(),
  };
  console.log("Seed complete:", totals);
}

/**
 * Replays the seeded activity through the same recipient rules the app uses,
 * so inboxes look realistic. Notifications older than three days are marked read.
 */
async function seedNotifications() {
  const activities = await prisma.activity.findMany({
    where: { mutantId: { not: null } },
    orderBy: { createdAt: "asc" },
    include: {
      actor: { select: { id: true, githubUsername: true } },
      mutant: {
        select: {
          id: true,
          title: true,
          createdById: true,
          projectId: true,
          project: { select: { displayName: true } },
          comments: { select: { userId: true, createdAt: true } },
          validations: { select: { userId: true, createdAt: true } },
        },
      },
    },
  });
  const members = await prisma.projectMember.findMany({
    where: { role: { in: ["REVIEWER", "MAINTAINER"] } },
    select: { projectId: true, userId: true },
  });
  const readBefore = daysAgo(3);
  let created = 0;
  for (const a of activities) {
    if (!a.mutant) continue;
    const payload = (a.payload ?? {}) as Record<string, unknown>;
    const detail =
      typeof payload.comment === "string"
        ? payload.comment
        : typeof payload.excerpt === "string"
          ? payload.excerpt
          : typeof payload.result === "string"
            ? payload.result
            : null;
    const drafts = buildNotifications(
      {
        type: a.type,
        actorId: a.actorId,
        actorUsername: a.actor?.githubUsername ?? null,
        mutant: { id: a.mutant.id, title: a.mutant.title, createdById: a.mutant.createdById },
        projectName: a.mutant.project.displayName,
        detail,
      },
      {
        // Only people who had already participated when the event happened.
        commenterIds: a.mutant.comments
          .filter((c) => c.createdAt < a.createdAt)
          .map((c) => c.userId),
        validatorIds: a.mutant.validations
          .filter((v) => v.createdAt < a.createdAt)
          .map((v) => v.userId),
        reviewerIds: members
          .filter((m) => m.projectId === a.mutant!.projectId)
          .map((m) => m.userId),
      },
    );
    if (!drafts.length) continue;
    const result = await prisma.notification.createMany({
      data: drafts.map((d) => ({
        userId: d.userId,
        type: a.type,
        actorId: a.actorId,
        mutantId: a.mutant!.id,
        projectId: a.mutant!.projectId,
        title: d.title,
        body: d.body,
        createdAt: a.createdAt,
        readAt: a.createdAt < readBefore ? new Date(a.createdAt.getTime() + 3600_000) : null,
      })),
    });
    created += result.count;
  }
  console.log(`  ${created} notifications`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
