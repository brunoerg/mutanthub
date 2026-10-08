import { expect, test, type Page } from "@playwright/test";

/**
 * Killing-test claims: a contributor reports that a merged PR kills a mutant,
 * MutantHub checks the PR and whether the code still applies at the merge
 * commit, reproductions verify the claim, and the mutant becomes killed.
 */

const MERGED_PR = 15890; // fixture: merged, touches lib/parsedate.c only

async function signInAs(page: Page, username: string) {
  await page.context().clearCookies();
  await page.goto("/signin");
  await page.locator("#mock-username").fill(username);
  await page.getByTestId("mock-sign-in-submit").click();
  await page.waitForURL(/\/dashboard/);
}

/** A surviving, approved curl mutant from the seed (parsedate year boundary). */
async function findMutant(page: Page): Promise<number> {
  const res = await page.request.get(
    "/api/mutants?project=curl/curl&file=lib/parsedate.c&mutationStatus=SURVIVED&reviewStatus=APPROVED&pageSize=1",
  );
  const body = (await res.json()) as { data: Array<{ id: number }> };
  expect(body.data.length).toBeGreaterThan(0);
  return body.data[0].id;
}

test.describe.configure({ mode: "serial" });

test.describe("killing-test claims", () => {
  let mutantId: number;

  test("a contributor reports a merged PR and the claim is checked against GitHub", async ({
    page,
  }) => {
    await signInAs(page, "frank");
    mutantId = await findMutant(page);
    await page.goto(`/mutants/${mutantId}`);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("kill-claim-reference").fill(`#${MERGED_PR}`);
    await page.getByTestId("kill-claim-note").fill("Adds a two-digit year test.");
    await page.getByTestId("kill-claim-submit").click();

    const claim = page.getByTestId("kill-claim").first();
    await expect(claim).toBeVisible();
    await expect(claim.getByTestId("kill-claim-status")).toHaveText("Claimed");
    await expect(claim).toContainText(`PR #${MERGED_PR}`);
    await expect(claim).toContainText("tracked · merged");
    await expect(claim.getByTestId("kill-claim-applies")).toHaveAttribute(
      "data-applies",
      /APPLIES|MOVED/,
    );

    // The claimed PR has its own page but is not listed as a tracked pull request.
    await page.goto(`/projects/curl/curl/pulls/${MERGED_PR}`);
    await expect(page.getByTestId("pull-request-files")).toContainText("lib/parsedate.c");
    await page.goto("/projects/curl/curl/pulls");
    await expect(
      page.getByTestId("pull-request-row").filter({ hasText: `#${MERGED_PR}` }),
    ).toHaveCount(0);
    await page.goto(`/mutants/${mutantId}`);

    // Unrecognised references and duplicates are rejected inline.
    await page.getByTestId("kill-claim-reference").fill("not a ref!");
    await page.getByTestId("kill-claim-submit").click();
    await expect(page.getByTestId("kill-claim-form").getByText(/Not recognised/)).toBeVisible();
    await page.getByTestId("kill-claim-reference").fill(`${MERGED_PR}`);
    await page.getByTestId("kill-claim-submit").click();
    await expect(page.getByTestId("kill-claim-form").getByText(/already claimed/)).toBeVisible();
  });

  test("two reproductions at the merge commit verify the claim and kill the mutant", async ({
    page,
  }) => {
    for (const user of ["erin", "grace"]) {
      await signInAs(page, user);
      await page.goto(`/mutants/${mutantId}`);
      await page.waitForLoadState("networkidle");
      await page.getByTestId("validation-open").click();
      const form = page.getByTestId("validation-form");
      await form.getByTestId("validation-result-KILLED").check({ force: true });
      const claimSelect = form.getByTestId("validation-claim");
      await claimSelect.selectOption({ index: 1 });
      await expect(form.getByTestId("validation-commit")).not.toHaveValue("");
      await form.getByTestId("validation-submit").click();
      await expect(page.getByTestId("validation-item")).toHaveCount(user === "erin" ? 3 : 4);
    }

    const claim = page.getByTestId("kill-claim").first();
    await expect(claim.getByTestId("kill-claim-status")).toHaveText("Verified");
    await expect(page.getByTestId("mutation-status").first()).toHaveAttribute(
      "data-status",
      "KILLED",
    );
    await expect(page.getByTestId("status-history")).toContainText(`Killed by PR #${MERGED_PR}`);

    // Reviewer controls disappear once the claim is resolved; the submitter was notified.
    await expect(page.getByTestId("kill-claim-verify")).toHaveCount(0);
    await signInAs(page, "dave");
    await page.getByTestId("notifications-bell").click();
    await expect(page.getByTestId("notifications-menu")).toContainText("killing test");
  });

  test("a reviewer can refute a fresh claim with a note", async ({ page }) => {
    await signInAs(page, "alice");
    await page.goto(`/mutants/${mutantId}`);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("kill-claim-reference").fill("tests/unit/unit1300.c");
    await page.getByTestId("kill-claim-submit").click();
    const fresh = page.getByTestId("kill-claim").last();
    await expect(fresh.getByTestId("kill-claim-status")).toHaveText("Claimed");

    await fresh.getByTestId("kill-claim-verify").click(); // reveals the note and the refute button
    await fresh.getByTestId("kill-claim-note-input").fill("That test does not cover the boundary.");
    await fresh.getByTestId("kill-claim-refute").click();
    await expect(fresh.getByTestId("kill-claim-status")).toHaveText("Refuted");
    await expect(fresh).toContainText("does not cover the boundary");

    const api = await page.request.get(`/api/export/mutants.json?file=lib/parsedate.c&limit=50`);
    const rows = (await api.json()) as Array<{ id: number; killClaims: string | null }>;
    const row = rows.find((r) => r.id === mutantId);
    expect(row?.killClaims).toContain(`PR #${MERGED_PR} (VERIFIED)`);
    expect(row?.killClaims).toContain("tests/unit/unit1300.c (REFUTED)");
  });
});
