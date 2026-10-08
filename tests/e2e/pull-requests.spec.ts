import { expect, test, type Page } from "@playwright/test";

/**
 * Pull request scope: track a PR (fixture-backed GitHub), open a changed file
 * in PR mode, submit a mutant on a changed line, and see it on the PR page.
 */

const OWNER = "curl";
const REPO = "curl";
const PR = 15908;
const CHANGED_LINE = 117;
const UNCHANGED_LINE = 30;

async function signInAs(page: Page, username: string) {
  await page.context().clearCookies();
  await page.goto("/signin");
  await page.locator("#mock-username").fill(username);
  await page.getByTestId("mock-sign-in-submit").click();
  await page.waitForURL(/\/dashboard/);
}

test.describe.configure({ mode: "serial" });

test.describe("pull requests", () => {
  const title = `PR mutant ${Date.now()}`;

  test("a signed-in user tracks a pull request and sees its changed files", async ({ page }) => {
    await signInAs(page, "frank");
    await page.goto(`/projects/${OWNER}/${REPO}`);
    await page.getByTestId("project-pulls-link").click();
    await page.waitForURL(/\/pulls$/);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("track-pull-request-number").fill(String(PR));
    await page.getByTestId("track-pull-request-submit").click();
    await page.waitForURL(new RegExp(`/pulls/${PR}$`));

    await expect(page.getByTestId("pull-request-page")).toContainText(
      "url: validate port numbers before use",
    );
    await expect(page.getByTestId("pull-request-state")).toHaveAttribute("data-state", "OPEN");
    await expect(page.getByTestId("pull-request-files")).toContainText("lib/url.c");

    // Tracking an unknown PR is reported inline, not as a crash.
    await page.goto(`/projects/${OWNER}/${REPO}/pulls`);
    await page.getByTestId("track-pull-request-number").fill("999999");
    await page.getByTestId("track-pull-request-submit").click();
    await expect(page.getByText(/not found/i)).toBeVisible();
  });

  test("pull request mode highlights changed lines and scopes the submission", async ({ page }) => {
    await signInAs(page, "frank");
    await page.goto(`/projects/${OWNER}/${REPO}/code/lib/url.c?pr=${PR}#L${UNCHANGED_LINE}`);
    await expect(page.locator('[data-testid="status-selected-line"]:visible')).toHaveText(
      `L${UNCHANGED_LINE}`,
    );
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("pull-request-notice")).toContainText(`PR #${PR}`);
    await expect(page.getByTestId("mutants-panel").getByTestId("line-outside-diff")).toContainText(
      "Only lines changed by the pull request can be mutated",
    );
    await expect(page.getByTestId("mutants-panel").getByTestId("suggest-mutant")).toBeDisabled();

    // Wait for Monaco itself (loaded from a CDN, slow on CI) before changing the selection.
    await expect(page.locator(".monaco-editor .view-lines")).toBeVisible({ timeout: 60_000 });
    await page.evaluate((line) => {
      window.location.hash = `L${line}`;
    }, CHANGED_LINE);
    await expect(page.getByTestId("mutants-panel").getByTestId("line-in-diff")).toBeVisible();
    // Monaco marks the changed lines once the selection is scrolled into view.
    await expect(page.locator(".mh-line-changed").first()).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("mutants-panel").getByTestId("suggest-mutant").click();
    const drawer = page.getByTestId("suggest-mutant-drawer");
    await expect(drawer.locator('input[name="pullRequestNumber"]')).toHaveValue(String(PR));
    await drawer.getByTestId("mutant-title").fill(title);
    const original = await drawer.getByTestId("mutant-original").inputValue();
    await drawer.getByTestId("mutant-mutated").fill(original.replace(">", ">="));
    await drawer.getByTestId("mutant-test-command").fill("make test-ci");
    await drawer.getByTestId("mutant-environment").fill("Debian 12, gcc 14 (pr mode)");
    await drawer.getByTestId("mutant-submit").click();
    await expect(drawer.getByTestId("mutant-success")).toBeVisible();
  });

  test("the server refuses a pull-request mutant outside the changed lines", async ({ page }) => {
    await signInAs(page, "frank");
    await page.goto(`/projects/${OWNER}/${REPO}/code/lib/url.c?pr=${PR}#L${CHANGED_LINE}`);
    await expect(page.locator('[data-testid="status-selected-line"]:visible')).toHaveText(
      `L${CHANGED_LINE}`,
    );
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("mutants-panel").getByTestId("line-in-diff")).toBeVisible();
    await page.getByTestId("mutants-panel").getByTestId("suggest-mutant").click();
    const drawer = page.getByTestId("suggest-mutant-drawer");
    await expect(drawer.locator('input[name="pullRequestNumber"]')).toHaveValue(String(PR));
    const original = await drawer.getByTestId("mutant-original").inputValue();
    await drawer.getByTestId("mutant-mutated").fill(`${original} /* outside */`);
    await drawer.getByTestId("mutant-test-command").fill("make test-ci");
    // Tamper with the form the way a crafted request would: move the mutant to an unchanged line.
    await drawer.locator('input[name="startLine"]').evaluate((el, line) => {
      (el as HTMLInputElement).value = String(line);
    }, UNCHANGED_LINE);
    await drawer.locator('input[name="endLine"]').evaluate((el, line) => {
      el.removeAttribute("min");
      (el as HTMLInputElement).value = String(line);
    }, UNCHANGED_LINE);
    await drawer.getByTestId("mutant-submit").click();
    await expect(drawer).toContainText(/outside the diff of PR #15908/);
    await expect(drawer.getByTestId("mutant-success")).toHaveCount(0);
  });

  test("the pull request page lists the mutant on the changed lines", async ({ page }) => {
    await page.goto(`/projects/${OWNER}/${REPO}/pulls/${PR}`);
    const table = page.getByTestId("mutant-table").first();
    await expect(table).toContainText(title);
    await expect(page.getByTestId("pull-request-files")).toContainText("lib/url.c");
    // The pull request shows in the project's list with its mutant count.
    await page.goto(`/projects/${OWNER}/${REPO}/pulls`);
    const row = page.getByTestId("pull-request-row").filter({ hasText: `#${PR}` });
    await expect(row).toBeVisible();
  });

  test("the mutant page names its pull request instead of an older revision", async ({ page }) => {
    await page.goto(`/projects/${OWNER}/${REPO}/pulls/${PR}`);
    await page.getByTestId("mutant-table").first().getByText(title).click();
    await page.waitForURL(/\/mutants\/\d+$/);
    // The mutant page can briefly hold a second (hidden) copy while it streams in.
    const notice = page.locator('[data-testid="pull-request-notice"]:visible');
    await expect(notice).toContainText(`#${PR} url: validate port numbers before use`);
    await expect(notice).toHaveAttribute("data-at-head", "true");
    await expect(notice.getByTestId("pull-request-state")).toHaveAttribute("data-state", "OPEN");
    await expect(page.getByTestId("older-revision-notice")).toHaveCount(0);
    await notice.getByRole("link", { name: `#${PR}`, exact: false }).click();
    await page.waitForURL(new RegExp(`/pulls/${PR}$`));
  });

  test("the pull request page filters its mutants and hides superseded results", async ({
    page,
  }) => {
    const HEAD = "e8d1c4b7a2f5e8d1c4b7a2f5e8d1c4b7a2f5e8d1";
    const OLDER = "a4c7e1f9b3d5a7c9e1f3b5d7a9c1e3f5b7d9a1c3";
    const survivor = "PR filters: inverted port bound";
    const killed = "PR filters: port multiplier";
    const offDiff = "PR filters: escape padding";
    const escapeRow = {
      file: "lib/escape.c",
      startLine: 87,
      originalCode: "  alloc = length * 3 + 1;",
      mutatedCode: "  alloc = length * 4 + 1;",
    };
    const upload = async (commit: string, mutants: object[]) => {
      await page.goto(`/projects/${OWNER}/${REPO}/import`);
      await page.waitForLoadState("networkidle");
      await page.getByTestId("import-file").setInputFiles({
        name: `pr-${commit.slice(0, 7)}.json`,
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({
            tool: { name: "pr-mutator", version: "1.0.0" },
            defaults: { commit, testCommand: "make test-ci", observedResult: "SURVIVED" },
            mutants,
          }),
        ),
      });
      await page.getByTestId("import-dry-run").click();
      await page.getByTestId("import-commit").click();
      await expect(page.getByTestId("import-done")).toBeVisible();
    };

    await signInAs(page, "bruno");
    // A run at the PR head: two mutants on changed lines of lib/url.c, one outside the diff.
    await upload(HEAD, [
      {
        file: "lib/url.c",
        startLine: 117,
        originalCode: "    if(value > MAX_PORT)",
        mutatedCode: "    if(value < MAX_PORT)",
        title: survivor,
      },
      {
        file: "lib/url.c",
        startLine: 116,
        originalCode: "    value = value * 10 + (unsigned long)(*p - '0');",
        mutatedCode: "    value = value * 11 + (unsigned long)(*p - '0');",
        title: killed,
        observedResult: "KILLED",
      },
      { ...escapeRow, title: offDiff },
    ]);

    const base = `/projects/${OWNER}/${REPO}/pulls/${PR}`;
    const onDiff = page.getByTestId("pr-mutants-on-diff");
    const other = page.getByTestId("pr-mutants-off-diff");
    await page.goto(base);
    await expect(onDiff).toContainText(survivor);
    await expect(onDiff).toContainText(killed);
    await expect(other).toContainText(offDiff);

    // The "Surviving" tile applies the outcome filter to both sections.
    await page.getByTestId("pr-stat-surviving").click();
    await page.waitForURL(/mutationStatus=SURVIVED/);
    await expect(page.getByTestId("pr-filter-mutation-status")).toHaveValue("SURVIVED");
    await expect(onDiff).toContainText(survivor);
    await expect(onDiff).not.toContainText(killed);
    await expect(other).toContainText(offDiff);

    // Filters combine: surviving mutants in one file.
    await page.goto(`${base}?mutationStatus=KILLED&file=lib/url.c`);
    await expect(onDiff).toContainText(killed);
    await expect(onDiff).not.toContainText(survivor);
    await expect(other).toHaveCount(0);

    // The same escape.c mutation is judged equivalent at another commit, which supersedes
    // the survivor recorded on the PR: it drops out unless superseded results are shown.
    await upload(OLDER, [{ ...escapeRow, title: `${offDiff} (older)` }]);
    await page.goto(
      `/projects/${OWNER}/${REPO}/mutants?q=${encodeURIComponent(offDiff)}&superseded=show`,
    );
    await page.getByText(`${offDiff} (older)`).click();
    await page.waitForURL(/\/mutants\/\d+$/);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("classify-status").click();
    await page.getByTestId("classify-option-EQUIVALENT").click();
    await page.getByTestId("classify-comment").fill("Padding is never read");
    await page.getByTestId("classify-submit").click();
    await expect(page.getByTestId("mutant-header").getByTestId("mutation-status")).toHaveAttribute(
      "data-status",
      "EQUIVALENT",
    );

    await page.goto(base);
    await expect(onDiff).toContainText(survivor);
    await expect(page.getByText(offDiff, { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("pr-stat-on-diff")).toContainText("1 superseded not counted");
    await page.goto(`${base}?superseded=only`);
    await expect(other).toContainText(offDiff);
    await expect(onDiff).not.toContainText(survivor);
  });
});
