import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

// Screenshot harness for the UI redesign (spec §8). SHOTS_DIR lets a worktree write into the main checkout.
const OUT = process.env.SHOTS_DIR ?? "../../.superpowers/sdd/2026-10-01-ui-redesign/shots";
const USERS = { steward: "00000000-0000-7000-8000-000000000b03", researcher: "00000000-0000-7000-8000-000000000a02", admin: "00000000-0000-7000-8000-000000000101" };
const DATASET_BATTERY = "00000000-0000-7000-8000-000000002001";

type Size = readonly [number, number];
const DEFAULT_SIZES: readonly Size[] = [[1440, 900], [390, 844]];

export async function shoot(page: Page, name: string, sizes: readonly Size[] = DEFAULT_SIZES) {
  mkdirSync(OUT, { recursive: true });
  for (const [w, h] of sizes) {
    for (const theme of w === 390 ? ["light"] : ["light", "dark"]) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: theme as "light" | "dark", reducedMotion: "reduce" });
      await page.waitForLoadState("networkidle");
      await page.screenshot({ path: `${OUT}/${name}-${w}-${theme}.png`, fullPage: true });
    }
  }
}

async function as(page: Page, who: keyof typeof USERS, baseURL: string) {
  await page.context().addCookies([{ name: "nais_mock_user", value: USERS[who], url: baseURL }]);
}

test.describe("screens", () => {
  // eslint-disable-next-line no-empty-pattern -- Playwright passes testInfo as the second argument only
  test.beforeEach(({}, info) => test.skip(info.project.name !== "chromium", "screenshots once"));

  test("baseline (tokens only, pre-redesign screens)", async ({ page, baseURL }) => {
    await as(page, "researcher", baseURL!);
    await page.goto("/commons");
    await expect(page.getByRole("heading", { level: 1, name: "대시보드" })).toBeVisible();
    await shoot(page, "baseline-commons", [[1440, 900]]);
    await page.goto(`/commons/data/${DATASET_BATTERY}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Battery Cycling Measurements");
    await shoot(page, "baseline-dataset", [[1440, 900]]);
  });

  test("ui gallery (Task 2 primitives)", async ({ page, baseURL }) => {
    await as(page, "researcher", baseURL!);
    await page.goto("/commons/_ui");
    await expect(page.getByRole("heading", { level: 1, name: "UI 부품" })).toBeVisible();
    // Capture only: the pre-Task-3 sticky header would be stamped mid-page by fullPage screenshots.
    await page.addStyleTag({ content: "header { position: static !important; }" });
    await shoot(page, "task2-ui-gallery");
  });
});
