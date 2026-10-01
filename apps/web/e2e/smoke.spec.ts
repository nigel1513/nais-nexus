import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const A_RESEARCHER = "00000000-0000-7000-8000-000000000a02";

async function seriousViolations(page: import("@playwright/test").Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help}`);
}

test("public landing renders the portal (not the gateway 503)", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Research Commons");
  await expect(page.getByRole("link", { name: "Research Commons 시작하기" })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});

test("mock login → dashboard → data search show mock data", async ({ page }) => {
  await page.goto("/commons");
  await expect(page).toHaveURL(/\/mock-login\?callbackUrl=%2Fcommons$/);
  await page.getByLabel("사용자").selectOption(A_RESEARCHER);
  await page.getByRole("button", { name: "로그인" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "대시보드" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Seed: Battery Materials Joint Study" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "알림 1개 읽지 않음" })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "데이터" }).click();
  await expect(page).toHaveURL(/\/commons\/data$/);
  await expect(page.getByRole("heading", { level: 2, name: "Battery Cycling Measurements" })).toBeVisible();
  await expect(page.getByText("총 4건")).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});

test("keyboard: the skip link is the first tab stop and moves focus to main", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "nais_mock_user", value: A_RESEARCHER, url: baseURL! }]);
  await page.goto("/commons");
  await expect(page.getByRole("heading", { level: 1, name: "대시보드" })).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "본문으로 건너뛰기" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
});

test("no secure-context-only APIs needed: dashboard renders without a service-unavailable error", async ({ page, context, baseURL }, testInfo) => {
  const secure = await page.goto("/").then(() => page.evaluate(() => window.isSecureContext));
  expect(secure).toBe(testInfo.project.name !== "chromium-insecure-origin");
  await context.addCookies([{ name: "nais_mock_user", value: A_RESEARCHER, url: baseURL! }]);
  await page.goto("/commons");
  await expect(page.getByRole("heading", { level: 1, name: "대시보드" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Seed: Battery Materials Joint Study" }).first()).toBeVisible();
  await expect(page.getByText(/서비스를 사용할 수 없|service unavailable/i)).toHaveCount(0);
  await expect(page.getByText("DEPENDENCY_UNAVAILABLE")).toHaveCount(0);
});
