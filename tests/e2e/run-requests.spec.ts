import { expect, test, type Page } from "@playwright/test";

/**
 * Run requests: a contributor asks for mutation testing on an open PR, the
 * project's reviewers hear about it, a runner claims it and reports the run,
 * and the requester closes it.
 */

const OWNER = "bitcoin";
const REPO = "bitcoin";
const PR = 31842; // fixture: open

async function signInAs(page: Page, username: string) {
  await page.context().clearCookies();
  await page.goto("/signin");
  await page.locator("#mock-username").fill(username);
  await page.getByTestId("mock-sign-in-submit").click();
  await page.waitForURL(/\/dashboard/);
}

test.describe.configure({ mode: "serial" });

test.describe("run requests", () => {
  let requestUrl: string;

  test("a contributor requests a run on an open pull request", async ({ page }) => {
    await signInAs(page, "frank");
    await page.goto(`/projects/${OWNER}/${REPO}`);
    await page.getByTestId("project-run-requests-link").click();
    await page.waitForURL(/\/requests$/);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("run-request-number").fill(String(PR));
    await page.getByTestId("run-request-notes").fill("Focus on the **minimal push** checks.");
    await page.getByTestId("run-request-submit").click();
    await page.waitForURL(/\/requests\/[a-z0-9]+$/);
    requestUrl = new URL(page.url()).pathname;

    const header = page.getByTestId("run-request-page");
    await expect(header).toContainText(`#${PR}`);
    await expect(header.getByTestId("run-request-status")).toHaveText("Open");
    await expect(page.getByText("minimal push", { exact: true })).toBeVisible();
    await expect(page.getByTestId("run-request-files")).toContainText("src/script/interpreter.cpp");

    // A second request for the same PR is refused while this one is open.
    await page.goto(`/projects/${OWNER}/${REPO}/requests`);
    await expect(page.getByTestId("run-request-row").first()).toContainText(`#${PR}`);
    await page.getByTestId("run-request-number").fill(String(PR));
    await page.getByTestId("run-request-submit").click();
    await expect(page.getByTestId("create-run-request-form")).toContainText(
      /already an open request/,
    );

    // The PR page links to it instead of offering the form.
    await page.goto(`/projects/${OWNER}/${REPO}/pulls/${PR}`);
    await expect(page.getByTestId("pr-run-request-link").first()).toBeVisible();
    await expect(page.getByTestId("pr-run-requests").getByTestId("run-request-submit")).toHaveCount(
      0,
    );
  });

  test("project reviewers are notified", async ({ page }) => {
    await signInAs(page, "bob");
    await page.goto("/notifications");
    await expect(
      page.getByTestId("notification-row").filter({ hasText: `@frank requested` }).first(),
    ).toContainText(`PR #${PR}`);
  });

  test("a runner claims the request and reports the run", async ({ page }) => {
    await signInAs(page, "dave");
    await page.goto(requestUrl);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("run-request-claim").click();
    await expect(page.getByTestId("run-claims")).toContainText("@dave");
    await expect(page.getByTestId("run-request-page").getByTestId("run-request-status")).toHaveText(
      "In progress",
    );

    const form = page.getByTestId("report-run-form");
    await form.getByTestId("report-tool").fill("mull");
    await form.getByTestId("report-generated").fill("10");
    await form.getByTestId("report-killed").fill("8");
    await form.getByTestId("report-survived").fill("5");
    await form.getByTestId("report-submit").click();
    await expect(form).toContainText("Killed + survived cannot exceed mutants generated");

    await form.getByTestId("report-survived").fill("2");
    await form.getByTestId("report-submit").click();
    const report = page.getByTestId("run-report").first();
    await expect(report).toContainText("mull");
    await expect(report.getByTestId("run-report-counts")).toContainText(
      "10 generated · 8 killed · 2 survived",
    );
    await expect(page.getByTestId("run-request-page").getByTestId("run-request-status")).toHaveText(
      "Reported",
    );
    // The report used up the claim.
    await expect(page.getByTestId("run-request-abandon")).toHaveCount(0);
  });

  test("only the requester or a reviewer can close it", async ({ page }) => {
    await signInAs(page, "dave");
    await page.goto(requestUrl);
    await expect(page.getByTestId("close-run-request-form")).toHaveCount(0);

    await signInAs(page, "frank");
    await page.goto("/notifications");
    await expect(
      page.getByTestId("notification-row").filter({ hasText: "@dave reported" }).first(),
    ).toContainText("2 survived");

    await page.goto(requestUrl);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("run-request-close").click();
    await expect(page.getByTestId("run-request-closed")).toBeVisible();
    await expect(page.getByTestId("run-request-page").getByTestId("run-request-status")).toHaveText(
      "Closed",
    );

    // Closed requests leave the default board, and the PR accepts a new one.
    await page.goto(`/projects/${OWNER}/${REPO}/requests?status=closed`);
    await expect(page.getByTestId("run-request-row").first()).toContainText(`#${PR}`);
    await page.goto(`/projects/${OWNER}/${REPO}/pulls/${PR}`);
    await expect(
      page.getByTestId("pr-run-requests").getByTestId("run-request-submit"),
    ).toBeVisible();
  });
});
