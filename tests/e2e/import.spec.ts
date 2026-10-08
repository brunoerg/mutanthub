import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Bulk import: an administrator uploads a tool's output, sees a dry-run
 * report (valid rows, duplicates, errors), imports, and the mutants appear
 * as approved with the tool as their source. Project maintainers can import
 * too; other members are refused.
 */

const EXAMPLE = path.join(process.cwd(), "docs/examples/import-example.json");

async function signInAs(page: Page, username: string) {
  await page.context().clearCookies();
  await page.goto("/signin");
  await page.locator("#mock-username").fill(username);
  await page.getByTestId("mock-sign-in-submit").click();
  await page.waitForURL(/\/dashboard/);
}

test.describe.configure({ mode: "serial" });

test.describe("bulk import", () => {
  test("an admin checks the file, imports it and the mutants are approved", async ({ page }) => {
    await signInAs(page, "bruno");
    await page.goto("/projects/curl/curl/settings");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("import-link").click();
    await expect(page.getByTestId("import-page")).toBeVisible();
    await page.waitForLoadState("networkidle");

    await page.getByTestId("import-file").setInputFiles(EXAMPLE);
    await page.getByTestId("import-dry-run").click();

    const report = page.getByTestId("import-report");
    await expect(report).toBeVisible();
    // 5 rows: 3 valid, 1 duplicate within the file, 1 whose original code is not in the file.
    await expect(report).toContainText("example-mutator 1.0.0");
    await expect(page.getByTestId("import-errors")).toContainText("row 5");
    await expect(page.getByTestId("import-errors")).toContainText("originalCode not found");
    await expect(page.getByTestId("import-duplicates")).toContainText("row 4: duplicate of row 3");
    await expect(page.getByTestId("import-commit")).toHaveText(/Import 3 mutants as approved/);

    await page.getByTestId("import-commit").click();
    await expect(page.getByTestId("import-done")).toContainText("3 mutants imported");
    await expect(page.getByTestId("import-batches")).toContainText(
      "3 mutants from example-mutator 1.0.0",
    );

    await page.getByTestId("import-view-link").click();
    await expect(page).toHaveURL(/\/projects\/curl\/curl\/mutants\?batch=/);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Off by one on the INT_MAX bound in unescape")).toBeVisible();
    await page.getByText("Off by one on the INT_MAX bound in unescape").click();
    await page.waitForURL(/\/mutants\/\d+$/);
    await expect(page.getByTestId("mutant-header").getByTestId("review-status")).toHaveAttribute(
      "data-status",
      "APPROVED",
    );
    await expect(page.getByTestId("status-history")).toContainText(
      "Imported from example-mutator 1.0.0",
    );
  });

  test("re-importing the same file skips the existing mutants", async ({ page }) => {
    await signInAs(page, "bruno");
    await page.goto("/projects/curl/curl/import");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("import-file").setInputFiles(EXAMPLE);
    await page.getByTestId("import-dry-run").click();
    await expect(page.getByTestId("import-duplicates")).toContainText(
      "already in the catalogue as #",
    );
    await expect(page.getByTestId("import-commit")).toBeDisabled();
  });

  test("a maintainer of the project can import", async ({ page }) => {
    await signInAs(page, "alice");
    await page.goto("/projects/curl/curl/settings");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("import-link").click();
    await expect(page.getByTestId("import-page")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.getByTestId("import-file").setInputFiles(EXAMPLE);
    await page.getByTestId("import-dry-run").click();
    await expect(page.getByTestId("import-report")).toContainText("example-mutator 1.0.0");
  });

  test("a survivor killed at a newer commit is hidden by the superseded filter", async ({
    page,
  }) => {
    const title = "Superseded: alloc padding in escape";
    const run = (commit: string, observedResult: string) => ({
      name: `run-${commit.slice(0, 7)}.json`,
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          tool: { name: "rerun-mutator", version: "1.0.0" },
          defaults: { commit, testCommand: "make test-ci", observedResult },
          mutants: [
            {
              file: "lib/escape.c",
              startLine: 87,
              originalCode: "  alloc = length * 3 + 1;",
              mutatedCode: "  alloc = length * 2 + 1;",
              title,
            },
          ],
        }),
      ),
    });

    await signInAs(page, "bruno");
    // Newer commit (August) first: import order must not matter, only commit order.
    for (const [commit, result] of [
      ["e8d1c4b7a2f5e8d1c4b7a2f5e8d1c4b7a2f5e8d1", "KILLED"],
      ["a4c7e1f9b3d5a7c9e1f3b5d7a9c1e3f5b7d9a1c3", "SURVIVED"],
    ]) {
      await page.goto("/projects/curl/curl/import");
      await page.waitForLoadState("networkidle");
      await page.getByTestId("import-file").setInputFiles(run(commit, result));
      await page.getByTestId("import-dry-run").click();
      await expect(page.getByTestId("import-commit")).toHaveText(/Import 1 mutant as approved/);
      if (result === "SURVIVED")
        await expect(page.getByTestId("import-related")).toContainText(
          "KILLED there, SURVIVED here",
        );
      await page.getByTestId("import-commit").click();
      await expect(page.getByTestId("import-done")).toContainText(/1 mutants? imported/);
    }

    await page.goto("/projects/curl/curl/mutants?mutationStatus=SURVIVED&superseded=show");
    await expect(page.getByTestId("filter-superseded")).toHaveValue("show");
    const row = page.getByRole("row").filter({ hasText: title });
    await expect(row.getByTestId("superseded")).toBeVisible();

    // Superseded results are hidden by default.
    await page.goto("/projects/curl/curl/mutants?mutationStatus=SURVIVED");
    await expect(page.getByTestId("filter-superseded")).toHaveValue("");
    await expect(page.getByText(title)).toHaveCount(0);

    await page.goto("/projects/curl/curl/mutants?mutationStatus=KILLED");
    await expect(page.getByText(title)).toBeVisible();
  });

  test("a repeated statement is only linked to the same place at another commit", async ({
    page,
  }) => {
    // lib/http.c returns CURLE_WEIRD_SERVER_REPLY from several checks; deleting each
    // is a different mutant, even though the code pair is identical.
    const deletion = (startLine: number, title: string, observedResult = "SURVIVED") => ({
      file: "lib/http.c",
      startLine,
      originalCode: "    return CURLE_WEIRD_SERVER_REPLY;",
      mutatedCode: "",
      mutationOperator: "STATEMENT_DELETION",
      title,
      observedResult,
    });
    const upload = async (commit: string, mutants: object[]) => {
      await page.goto("/projects/curl/curl/import");
      await page.waitForLoadState("networkidle");
      await page.getByTestId("import-file").setInputFiles({
        name: `repeat-${commit.slice(0, 7)}.json`,
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({ defaults: { commit, testCommand: "make test-ci" }, mutants }),
        ),
      });
      await page.getByTestId("import-dry-run").click();
      await expect(page.getByTestId("import-commit")).toBeEnabled();
    };
    const open = async (title: string) => {
      await page.goto(`/projects/curl/curl/mutants?q=${encodeURIComponent(title)}`);
      await page.getByText(title, { exact: true }).click();
      await page.waitForURL(/\/mutants\/\d+$/);
    };

    await signInAs(page, "bruno");
    await upload("e8d1c4b7a2f5e8d1c4b7a2f5e8d1c4b7a2f5e8d1", [
      deletion(39, "Repeat: length check"),
      deletion(42, "Repeat: HTTP/ prefix"),
      deletion(45, "Repeat: sscanf"),
    ]);
    await expect(page.getByTestId("import-related")).toHaveCount(0);
    await page.getByTestId("import-commit").click();
    await expect(page.getByTestId("import-done")).toBeVisible();

    for (const title of ["Repeat: length check", "Repeat: HTTP/ prefix", "Repeat: sscanf"]) {
      await open(title);
      await expect(page.getByTestId("mutant-header")).toContainText(title);
      await expect(page.getByTestId("possible-duplicate-notice")).toHaveCount(0);
    }

    // An earlier run of the same check links to that one mutant only.
    await upload("a4c7e1f9b3d5a7c9e1f3b5d7a9c1e3f5b7d9a1c3", [
      deletion(42, "Repeat: HTTP/ prefix (older)", "KILLED"),
    ]);
    const related = page.getByTestId("import-related");
    await expect(related).toContainText("e8d1c4b:42: SURVIVED there, KILLED here");
    await expect(related.locator("li")).toHaveCount(1);
    await page.getByTestId("import-commit").click();
    await expect(page.getByTestId("import-done")).toBeVisible();

    await open("Repeat: HTTP/ prefix");
    const notice = page.getByTestId("possible-duplicate-notice");
    await expect(notice.locator("li")).toHaveCount(1);
    await expect(notice).toContainText("Repeat: HTTP/ prefix (older)");
    await open("Repeat: sscanf");
    await expect(page.getByTestId("possible-duplicate-notice")).toHaveCount(0);
  });

  for (const username of ["frank", "erin"]) {
    test(`${username} (not a maintainer) cannot open the page or call the endpoint`, async ({
      page,
    }) => {
      await signInAs(page, username);
      await page.goto("/projects/curl/curl/import");
      await expect(
        page.getByText(/Only project maintainers and administrators can import/),
      ).toBeVisible();
      const res = await page.request.post("/api/projects/curl/curl/import", {
        multipart: {
          file: { name: "m.json", mimeType: "application/json", buffer: readFileSync(EXAMPLE) },
          mode: "commit",
        },
      });
      expect(res.status()).toBe(403);
    });
  }
});
