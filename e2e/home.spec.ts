import { expect, test } from "@playwright/test";

/**
 * E2E tests for the home page.
 */
test.describe("Home Page", () => {
  test("should display the welcome message", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Welcome");
  });

  test("should have correct page title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/App/);
  });

  test("should be responsive on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible();
  });
});
