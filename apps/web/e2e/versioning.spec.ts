import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Stage 2 versioning journey (spec §3.3b): history tab → compare v1.1 ↔ v2.0 in three layers → one file's history →
// the version page's citation, copied. Read-only, so the shared mock store (one per server process) stays as it is.
const RESEARCHER = "00000000-0000-7000-8000-000000000a02";
const DATASET = "00000000-0000-7000-8000-000000002001";

async function seriousViolations(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity));
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help}`);
}

test("versioning journey: history → compare → file history → citation copy", async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: "nais_mock_user", value: RESEARCHER, url: baseURL! }]);
  await page.goto(`/commons/data/${DATASET}?tab=versions`);
  const latest = page.getByRole("list", { name: "게시 이력" }).getByRole("listitem", { name: /^v2\.0 / });
  await latest.getByRole("link", { name: "비교" }).click();

  await expect(page).toHaveURL(/\/versions\/compare\?to=/);
  await expect(page.getByRole("heading", { level: 1, name: "v1.1 → v2.0" })).toBeVisible();
  await expect(page.getByText("추가 2 · 삭제 0 · 변경 2")).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForLoadState("networkidle");
    expect(await seriousViolations(page)).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });

  await page.getByRole("button", { name: "data/measurements.csv 이력" }).click();
  const history = page.getByRole("region", { name: "파일 이력" });
  await expect(history.getByRole("listitem")).toHaveCount(3);
  await expect(page).toHaveURL(/file=data%2Fmeasurements\.csv/);

  await page.getByRole("tab", { name: /^데이터 구조/ }).click();
  await expect(page.getByRole("region", { name: "data/measurements.csv" })).toContainText("행 수");
  await page.getByRole("tab", { name: /^메타데이터/ }).click();
  await expect(page.getByRole("table", { name: "메타데이터" }).getByText("license", { exact: true })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto(`/commons/data/${DATASET}/versions/00000000-0000-7000-8000-000000002101`);
  const citation = page.getByRole("region", { name: "이 버전 인용하기" });
  await expect(citation).toContainText("v2.0에 고정된 인용입니다");
  await citation.getByRole("tab", { name: "BibTeX" }).click();
  await expect(citation.getByText(/@misc\{/)).toBeVisible();
  await citation.getByRole("button", { name: "복사" }).click();
  await expect(page.getByText("복사했습니다")).toBeVisible();
});
