import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

// Screenshot harness for the UI redesign (spec §8). SHOTS_DIR lets a worktree write into the main checkout.
// Run: corepack pnpm --dir apps/web exec playwright test e2e/screens.spec.ts --project=chromium
const OUT = process.env.SHOTS_DIR ?? "../../.superpowers/sdd/2026-10-01-ui-redesign/shots";
const USERS = { steward: "00000000-0000-7000-8000-000000000b03", researcher: "00000000-0000-7000-8000-000000000a02", admin: "00000000-0000-7000-8000-000000000101" };
const DATASET_BATTERY = "00000000-0000-7000-8000-000000002001";

type Size = readonly [number, number];
type Theme = "light" | "dark";
const DEFAULT_SIZES: readonly Size[] = [[1440, 900], [390, 844]];

/** Saves `<name>-<width>-<theme>.png`: 1440 light + dark, 390 light (spec §8). */
export async function shoot(page: Page, name: string, sizes: readonly Size[] = DEFAULT_SIZES, { fullPage = true }: { fullPage?: boolean } = {}) {
  mkdirSync(OUT, { recursive: true });
  for (const [w, h] of sizes) {
    for (const theme of (w === 390 ? ["light"] : ["light", "dark"]) as Theme[]) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.waitForLoadState("networkidle");
      await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
      await page.screenshot({ path: `${OUT}/${name}-${w}-${theme}.png`, fullPage });
    }
  }
}

/** One width and theme, e.g. an open popover that a resize would close. */
async function shootOne(page: Page, name: string, width: number, theme: Theme) {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(250); // let a reduced-motion opacity transition (120ms) finish
  await page.screenshot({ path: `${OUT}/${name}-${width}-${theme}.png` });
}

async function as(page: Page, who: keyof typeof USERS, baseURL: string) {
  await page.context().addCookies([{ name: "nais_mock_user", value: USERS[who], url: baseURL }]);
}

async function setup(page: Page, [w, h]: Size, theme: Theme) {
  await page.setViewportSize({ width: w, height: h });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
}

test.describe("screens", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "chromium", "screenshots once"));

  test("ui gallery (Task 2 primitives)", async ({ page, baseURL }) => {
    await as(page, "researcher", baseURL!);
    await page.goto("/commons/_ui");
    await expect(page.getByRole("heading", { level: 1, name: "UI 부품" })).toBeVisible();
    await shoot(page, "task2-ui-gallery");
  });

  test("shell on dashboard, data search and data card", async ({ page, baseURL }) => {
    await as(page, "steward", baseURL!);
    await page.goto("/commons");
    await expect(page.getByRole("navigation", { name: "주 메뉴" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "대시보드" })).toBeVisible();
    await shoot(page, "task3-shell-dashboard");

    await page.goto("/commons/data");
    await expect(page.getByRole("heading", { level: 2, name: "Battery Cycling Measurements" })).toBeVisible();
    await shoot(page, "task3-shell-data-search");

    await page.goto(`/commons/data/${DATASET_BATTERY}`);
    await expect(page.getByRole("heading", { level: 1, name: "Battery Cycling Measurements" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "현재 위치" })).toContainText("Battery Cycling Measurements");
    await shoot(page, "task3-shell-data-card");
  });

  test("shell overlays: ⌘K, notifications, user menu, collapsed rail, phone sheet", async ({ page, baseURL }) => {
    await as(page, "researcher", baseURL!);
    for (const theme of ["light", "dark"] as Theme[]) {
      await setup(page, [1440, 900], theme);
      await page.goto("/commons");
      await expect(page.getByRole("heading", { level: 1, name: "대시보드" })).toBeVisible();

      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByRole("dialog", { name: "명령 팔레트" });
      await expect(palette).toBeVisible();
      await page.keyboard.type("battery");
      await expect(palette.getByRole("option", { name: /Battery Cycling Measurements/ })).toBeVisible();
      await shootOne(page, "task3-cmdk", 1440, theme);
      await page.keyboard.press("Escape");
      await expect(palette).toBeHidden();

      await page.getByRole("button", { name: "알림 1개 읽지 않음" }).click();
      await expect(page.getByRole("dialog", { name: "알림" })).toBeVisible();
      await shootOne(page, "task3-notifications", 1440, theme);
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: /A Researcher/ }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await shootOne(page, "task3-user-menu", 1440, theme);
      await page.keyboard.press("Escape");
    }

    await setup(page, [1440, 900], "light");
    await page.getByRole("button", { name: "사이드바 접기" }).click();
    await expect(page.getByRole("button", { name: "사이드바 펼치기" })).toBeVisible();
    await shootOne(page, "task3-rail", 1440, "light");
    await page.getByRole("button", { name: "사이드바 펼치기" }).click();

    await setup(page, [390, 844], "light");
    await page.goto("/commons");
    await page.getByRole("button", { name: "메뉴" }).click();
    await expect(page.getByRole("dialog", { name: "메뉴" })).toBeVisible();
    await shootOne(page, "task3-sheet", 390, "light");
  });

  test("dataset register form and edit sheet (Task 7)", async ({ page, baseURL }) => {
    const prefix = process.env.SHOT_PREFIX ?? "task7";
    await as(page, "steward", baseURL!);
    await page.goto("/commons/data/new");
    await expect(page.getByRole("heading", { level: 1, name: "데이터셋 등록" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: /담당자/ })).toHaveValue(/B Steward/);
    await shoot(page, `${prefix}-dataset-new`);

    if (prefix === "task7") {
      for (const theme of ["light", "dark"] as Theme[]) {
        await setup(page, [1440, 900], theme);
        await page.getByRole("combobox", { name: /연구책임자/ }).fill("B R");
        await expect(page.getByRole("option", { name: /B Researcher/ })).toBeVisible();
        await shootOne(page, `${prefix}-user-picker`, 1440, theme);
        await page.keyboard.press("Escape");
        await page.getByRole("combobox", { name: /연구책임자/ }).fill("");

        await page.getByRole("button", { name: "연구 분야 선택" }).click();
        const vocab = page.getByRole("dialog", { name: "연구 분야" });
        for (const name of ["재료", "에너지"]) await vocab.getByRole("checkbox", { name }).check();
        await shootOne(page, `${prefix}-vocabulary-picker`, 1440, theme);
        await page.keyboard.press("Escape");

        await page.getByLabel("데이터 기간 시작").fill("2025-03-02");
        await page.getByLabel("데이터 기간 끝").fill("2025-03-20");
        await page.getByRole("button", { name: "달력에서 기간 고르기" }).click();
        await expect(page.getByRole("grid")).toBeVisible();
        await shootOne(page, `${prefix}-date-range`, 1440, theme);
        await page.keyboard.press("Escape");
        await page.reload();
        await expect(page.getByRole("heading", { level: 1, name: "데이터셋 등록" })).toBeVisible();
      }
    }

    for (const [size, theme] of [[[1440, 900], "light"], [[1440, 900], "dark"], [[390, 844], "light"]] as [Size, Theme][]) {
      await setup(page, size, theme);
      await page.goto(`/commons/data/${DATASET_BATTERY}`);
      await expect(page.getByRole("heading", { level: 1, name: "Battery Cycling Measurements" })).toBeVisible();
      await page.getByRole("button", { name: "편집" }).click();
      await expect(page.getByLabel(/^제목/)).toBeVisible();
      await page.waitForLoadState("networkidle");
      await shootOne(page, `${prefix}-dataset-edit-sheet`, size[0], theme);
    }
  });
});
