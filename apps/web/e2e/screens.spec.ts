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
});

// Task 9: access management. The mock API lives in the web server's memory, so seeding through it shows up on the next page load.
const MOCK_USERS = { aResearcher: "00000000-0000-7000-8000-000000000a02", aSteward: "00000000-0000-7000-8000-000000000a03", aAdmin: "00000000-0000-7000-8000-000000000a01" };
const T9 = process.env.SHOT_PREFIX ?? "task9";

async function seedReviewQueue(page: Page, baseURL: string): Promise<string> {
  const api = (path: string, user: string, data?: unknown) =>
    data === undefined
      ? page.request.get(`${baseURL}/mock-api/v1${path}`, { headers: { "x-mock-user": user } })
      : page.request.post(`${baseURL}/mock-api/v1${path}`, { headers: { "x-mock-user": user }, data });
  const pending = (await (await api("/access-requests?role=reviewer&status=SUBMITTED&status=UNDER_REVIEW", USERS.steward)).json()) as { items: { access_request_id: string; status: string }[] };
  if (pending.items.length >= 3) return pending.items.find((r) => r.status === "SUBMITTED")?.access_request_id ?? pending.items[0]!.access_request_id;
  const file = async (user: string, project: string, body: Record<string, unknown>) => {
    const p = (await (await api("/projects", user, { name: project, description: "접근 요청 화면 시연" })).json()) as { project_id: string };
    const r = await api("/access-requests", user, { project_id: p.project_id, operations: ["READ"], ...body });
    return r.ok() ? ((await r.json()) as { access_request_id: string }).access_request_id : null;
  };
  await file(MOCK_USERS.aSteward, "센서 융합 공동연구", { dataset_id: DATASET_BATTERY, purpose: "ACADEMIC_RESEARCH", purpose_detail: "충방전 사이클 데이터로 열화 지표를 비교하는 공동연구에 사용합니다.", requested_days: 30 });
  await file(MOCK_USERS.aAdmin, "기관 품질 비교", { dataset_id: DATASET_BATTERY, purpose: "ACADEMIC_RESEARCH", purpose_detail: "두 기관의 셀 시험 기록 형식을 비교해 공통 단위 규칙을 정리합니다.", requested_days: 60 });
  const id = await file(MOCK_USERS.aResearcher, "열화 예측 모델 학습", {
    dataset_id: DATASET_BATTERY,
    purpose: "AI_TRAINING",
    purpose_detail: "배터리 열화 예측 모델을 학습하기 위해 셀별 충방전 곡선과 온도 기록을 사용합니다.\n학습 결과는 기관 내부 보고서에만 사용합니다.",
    requested_days: 90,
  });
  return id!;
}

test.describe("task 9 screens", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "chromium", "screenshots once"));

  test("access review list and steward request detail", async ({ page, baseURL }) => {
    const id = await seedReviewQueue(page, baseURL!);
    await as(page, "steward", baseURL!);
    await page.goto("/commons/access?tab=review");
    await expect(page.getByRole("heading", { level: 1, name: "접근 관리" })).toBeVisible();
    await expect(page.getByText("A Researcher").first()).toBeVisible();
    await shoot(page, `${T9}-access-review`);

    await page.goto(`/commons/access/${id}`);
    await expect(page.getByRole("button", { name: "승인" }).first()).toBeVisible();
    await shoot(page, `${T9}-access-detail-steward`);
  });

  test("my requests, my grants and the download panel", async ({ page, baseURL }) => {
    await as(page, "researcher", baseURL!);
    await page.goto("/commons/access");
    await expect(page.getByRole("link", { name: "Battery Cycling Measurements" }).first()).toBeVisible();
    await shoot(page, `${T9}-access-requests`, [[1440, 900]]);
    await page.goto("/commons/access?tab=grants");
    await expect(page.getByRole("link", { name: "다운로드" }).first()).toBeVisible();
    await shoot(page, `${T9}-access-grants`, [[1440, 900]]);
    await page.goto("/commons/access/00000000-0000-7000-8000-000000003001");
    await expect(page.getByRole("link", { name: "다운로드" })).toBeVisible();
    await shoot(page, `${T9}-access-detail-requester`, [[1440, 900]]);

    await page.goto(`/commons/data/${DATASET_BATTERY}/versions/00000000-0000-7000-8000-000000002101`);
    const panel = page.getByRole("region", { name: "다운로드" });
    await panel.getByRole("button", { name: "다운로드 링크 받기" }).click();
    await expect(panel.getByRole("link").first()).toBeVisible();
    await panel.scrollIntoViewIfNeeded();
    for (const theme of ["light", "dark"] as Theme[]) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      mkdirSync(OUT, { recursive: true });
      await panel.screenshot({ path: `${OUT}/${T9}-download-1440-${theme}.png` });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await panel.screenshot({ path: `${OUT}/${T9}-download-390-light.png` });

    await page.context().clearCookies();
    await as(page, "admin", baseURL!);
    await page.goto("/commons/access");
    await expect(page.getByText("보낸 접근 요청이 없습니다.")).toBeVisible();
    await shoot(page, `${T9}-access-empty`, [[1440, 900]]);
  });
});
