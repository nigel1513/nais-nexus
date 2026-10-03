import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

// Screenshot harness for the UI redesign (spec §8). SHOTS_DIR lets a worktree write into the main checkout.
// Run: corepack pnpm --dir apps/web exec playwright test e2e/screens.spec.ts --project=chromium
const OUT = process.env.SHOTS_DIR ?? "../../.superpowers/sdd/2026-10-01-ui-redesign/shots";
const USERS = { gated: "00000000-0000-7000-8000-000000000a01", steward: "00000000-0000-7000-8000-000000000b03", researcher: "00000000-0000-7000-8000-000000000a02", admin: "00000000-0000-7000-8000-000000000101", bAdmin: "00000000-0000-7000-8000-000000000b01" };
const DATASET_BATTERY = "00000000-0000-7000-8000-000000002001";
const PROJECT_SEED = "00000000-0000-7000-8000-000000001001";

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

  test("landing and demo login", async ({ page }) => {
    const prefix = process.env.SHOT_PREFIX ?? "landing";
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Scroll like a reader so every once-only reveal has fired before the full-page shots.
    for (let i = 0; i < 16; i += 1) {
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(80);
    }
    await expect(page.locator(".lp-reveal[data-pre]")).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1200);
    await shoot(page, `${prefix}-home`);
    await page.goto("/mock-login");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await shoot(page, `${prefix}-mock-login`);
  });

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
    await expect(page.getByRole("heading", { level: 3, name: "리튬이온 배터리 셀 사이클 시험 데이터" })).toBeVisible();
    await shoot(page, "task3-shell-data-search");

    await page.goto(`/commons/data/${DATASET_BATTERY}`);
    await expect(page.getByRole("heading", { level: 1, name: "리튬이온 배터리 셀 사이클 시험 데이터" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "현재 위치" })).toContainText("리튬이온 배터리 셀 사이클 시험 데이터");
    await shoot(page, "task3-shell-data-card");
  });

  test("task4 data search (steward) and empty result", async ({ page, baseURL }) => {
    await as(page, "steward", baseURL!);
    await page.goto("/commons/data");
    await expect(page.getByRole("heading", { level: 3, name: "리튬이온 배터리 셀 사이클 시험 데이터" })).toBeVisible();
    await shoot(page, "task4-data-search");

    await setup(page, [1440, 900], "light");
    await page.goto("/commons/data?view=table");
    await expect(page.getByRole("table", { name: /검색 결과/ })).toBeVisible();
    await shoot(page, "task4-data-search-table", [[1440, 900]]);

    await page.goto("/commons/data?q=zzzz");
    await expect(page.getByText("조건에 맞는 데이터가 없습니다.")).toBeVisible();
    await shoot(page, "task4-data-search-empty");

    await setup(page, [390, 844], "light");
    await page.goto("/commons/data?access_level=CONTROLLED");
    await page.getByRole("button", { name: /^필터/ }).click();
    await expect(page.getByRole("dialog", { name: "필터" })).toBeVisible();
    await shootOne(page, "task4-data-search-filters", 390, "light");
  });

  test("task5 data card (steward, gated researcher) and explorer column view", async ({ page, baseURL }) => {
    await as(page, "steward", baseURL!);
    await page.goto(`/commons/data/${DATASET_BATTERY}`);
    await expect(page.getByRole("heading", { level: 1, name: "리튬이온 배터리 셀 사이클 시험 데이터" })).toBeVisible();
    await expect(page.getByRole("img", { name: /분포/ }).first()).toBeVisible();
    await shoot(page, "task5-data-card-steward");

    await setup(page, [1440, 900], "light");
    await page.getByText("Column", { exact: true }).click();
    await expect(page.getByRole("table", { name: /열 요약/ })).toBeVisible();
    await shoot(page, "task5-data-card-explorer-column", [[1440, 900]]);

    await page.context().clearCookies();
    await as(page, "gated", baseURL!);
    await setup(page, [1440, 900], "light");
    await page.goto(`/commons/data/${DATASET_BATTERY}`);
    await expect(page.getByText("접근 승인 후 미리보기 가능")).toBeVisible();
    await shoot(page, "task5-data-card-researcher-gated");
  });

  test("v2 data search and data card", async ({ page, baseURL }) => {
    const tag = process.env.V2_TAG ?? "after";
    await as(page, "steward", baseURL!);
    await page.goto("/commons/data");
    await expect(page.getByRole("heading", { level: 3, name: "리튬이온 배터리 셀 사이클 시험 데이터" })).toBeVisible();
    await shoot(page, `v2-data-search-${tag}`);
    await setup(page, [1440, 900], "light");
    await page.goto("/commons/data?view=table");
    await expect(page.getByRole("table", { name: /검색 결과/ })).toBeVisible();
    await shoot(page, `v2-data-search-table-${tag}`, [[1440, 900]]);

    await page.goto(`/commons/data/${DATASET_BATTERY}`);
    await expect(page.getByRole("heading", { level: 1, name: "리튬이온 배터리 셀 사이클 시험 데이터" })).toBeVisible();
    await expect(page.getByRole("img", { name: /분포/ }).first()).toBeVisible();
    await shoot(page, `v2-data-card-${tag}`);
    await setup(page, [1440, 900], "light");
    await page.getByText("Column", { exact: true }).click();
    await expect(page.getByRole("table", { name: /열 요약/ })).toBeVisible();
    await shoot(page, `v2-data-card-column-${tag}`, [[1440, 900]]);

    await page.context().clearCookies();
    await as(page, "gated", baseURL!);
    await setup(page, [1440, 900], "light");
    await page.goto(`/commons/data/${DATASET_BATTERY}`);
    await expect(page.getByText("접근 승인 후 미리보기 가능")).toBeVisible();
    await shoot(page, `v2-data-card-gated-${tag}`, [[1440, 900]]);
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
      await page.keyboard.type("배터리");
      await expect(palette.getByRole("option", { name: /리튬이온 배터리 셀 사이클 시험 데이터/ })).toBeVisible();
      await shootOne(page, "task3-cmdk", 1440, theme);
      await page.keyboard.press("Escape");
      await expect(palette).toBeHidden();

      await page.getByRole("button", { name: "알림 1개 읽지 않음" }).click();
      await expect(page.getByRole("dialog", { name: "알림" })).toBeVisible();
      await shootOne(page, "task3-notifications", 1440, theme);
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: /김민준/ }).click();
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
    await expect(page.getByRole("group", { name: /담당자/ })).toContainText("정현우");
    await shoot(page, `${prefix}-dataset-new`);

    if (prefix === "task7") {
      for (const theme of ["light", "dark"] as Theme[]) {
        await setup(page, [1440, 900], theme);
        await page.getByRole("combobox", { name: /연구책임자/ }).fill("최유진");
        await expect(page.getByRole("option", { name: /최유진/ })).toBeVisible();
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
      await expect(page.getByRole("heading", { level: 1, name: "리튬이온 배터리 셀 사이클 시험 데이터" })).toBeVisible();
      await page.getByRole("button", { name: "편집" }).click();
      await expect(page.getByLabel(/^제목/)).toBeVisible();
      await page.waitForLoadState("networkidle");
      await shootOne(page, `${prefix}-dataset-edit-sheet`, size[0], theme);
    }
  });
  test("projects list and project detail members (Task 8)", async ({ page, baseURL }) => {
    const prefix = process.env.SHOT_PREFIX ?? "task8";
    await as(page, "researcher", baseURL!);
    await page.goto("/commons/projects");
    await expect(page.getByRole("heading", { level: 1, name: "프로젝트" })).toBeVisible();
    await expect(page.getByRole("link", { name: "차세대 이차전지 소재 공동연구" }).first()).toBeVisible();
    await shoot(page, `${prefix}-projects-list`);

    await page.goto(`/commons/projects/${PROJECT_SEED}/members`);
    await expect(page.getByRole("heading", { level: 1, name: "차세대 이차전지 소재 공동연구" })).toBeVisible();
    await shoot(page, `${prefix}-project-detail-members`);

    await page.goto(`/commons/projects/${PROJECT_SEED}`);
    await expect(page.getByRole("heading", { level: 1, name: "차세대 이차전지 소재 공동연구" })).toBeVisible();
    await shoot(page, `${prefix}-project-detail-overview`, [[1440, 900]]);

    await page.goto("/commons/projects/new");
    await expect(page.getByRole("heading", { level: 1, name: "새 프로젝트" })).toBeVisible();
    await shoot(page, `${prefix}-project-new`, [[1440, 900]]);
  });
});

test.describe("v2 track B: dataset form and projects", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "chromium", "screenshots once"));
  // V2_PHASE=before|after: v2-dataset-form-<phase>-*, v2-projects-<phase>-*.
  const phase = process.env.V2_PHASE ?? "after";

  test("dataset form (new page and edit sheet)", async ({ page, baseURL }) => {
    await as(page, "steward", baseURL!);
    await page.goto("/commons/data/new");
    await expect(page.getByRole("heading", { level: 1, name: /데이터셋 등록/ })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("group", { name: /담당자/ })).toContainText("정현우");
    await shoot(page, `v2-dataset-form-${phase}-new`);
    await setup(page, [1440, 900], "light");
    await shootOne(page, `v2-dataset-form-${phase}-new-fold`, 1440, "light");
    for (const [size, theme] of [[[1440, 900], "light"], [[1440, 900], "dark"], [[390, 844], "light"]] as [Size, Theme][]) {
      await setup(page, size, theme);
      await page.goto(`/commons/data/${DATASET_BATTERY}`);
      await expect(page.getByRole("heading", { level: 1, name: "리튬이온 배터리 셀 사이클 시험 데이터" })).toBeVisible();
      await page.getByRole("button", { name: "편집" }).click();
      await expect(page.getByLabel(/^제목/)).toBeVisible();
      await page.waitForLoadState("networkidle");
      await shootOne(page, `v2-dataset-form-${phase}-edit`, size[0], theme);
    }
  });

  test("projects list, detail and new", async ({ page, baseURL }) => {
    await as(page, "researcher", baseURL!);
    await page.goto("/commons/projects");
    await expect(page.getByRole("link", { name: "차세대 이차전지 소재 공동연구" }).first()).toBeVisible();
    await shoot(page, `v2-projects-${phase}-list`);
    await page.goto(`/commons/projects/${PROJECT_SEED}`);
    await expect(page.getByRole("heading", { level: 1, name: "차세대 이차전지 소재 공동연구" })).toBeVisible();
    await shoot(page, `v2-projects-${phase}-detail`);
    await page.goto(`/commons/projects/${PROJECT_SEED}/members`);
    await expect(page.getByRole("heading", { level: 1, name: "차세대 이차전지 소재 공동연구" })).toBeVisible();
    await shoot(page, `v2-projects-${phase}-members`, [[1440, 900]]);
    await page.goto("/commons/projects/new");
    await expect(page.getByRole("heading", { level: 1, name: /새 프로젝트/ })).toBeVisible();
    await shoot(page, `v2-projects-${phase}-new`);
  });
});

// Task 9: access management. The mock API lives in the web server's memory, so seeding through it shows up on the next page load.
const MOCK_USERS = { aResearcher: "00000000-0000-7000-8000-000000000a02", aSteward: "00000000-0000-7000-8000-000000000a03", aAdmin: "00000000-0000-7000-8000-000000000a01", bResearcher: "00000000-0000-7000-8000-000000000b02" };
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
    await expect(page.getByText("김민준").first()).toBeVisible();
    await shoot(page, `${T9}-access-review`);

    await page.goto(`/commons/access/${id}`);
    await expect(page.getByRole("button", { name: "승인" }).first()).toBeVisible();
    await shoot(page, `${T9}-access-detail-steward`);
  });

  test("my requests, my grants and the download panel", async ({ page, baseURL }) => {
    await as(page, "researcher", baseURL!);
    await page.goto("/commons/access");
    await expect(page.getByRole("link", { name: "리튬이온 배터리 셀 사이클 시험 데이터" }).first()).toBeVisible();
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

// Task 10: activity and notifications.
const T10 = process.env.SHOT_PREFIX_10 ?? "task10";
const SENSORS_VERSION = "00000000-0000-7000-8000-000000002104";

/**
 * Decided requests (approved / rejected with a reason / changes requested), a project invitation and a denied download,
 * so the timeline shows reasons and a DENIED row and A Steward's notifications cover several kinds. A Steward, not
 * A Researcher, receives them: the smoke tests count A Researcher's unread notifications on the same server.
 */
async function seedTask10(page: Page, baseURL: string) {
  const call = (method: "get" | "post", path: string, user: string, data?: unknown) =>
    page.request[method](`${baseURL}/mock-api/v1${path}`, { headers: { "x-mock-user": user }, ...(data === undefined ? {} : { data }) });
  const notes = (await (await call("get", "/notifications?limit=50", MOCK_USERS.aSteward)).json()) as { items: { type: string }[] };
  if (notes.items.some((n) => n.type === "ACCESS_REJECTED")) return;
  // The mock seeds its audit log a few seconds into the future; wait until "now" passes it so the new rows sort on top.
  const newest = (await (await call("get", "/audit-events?limit=1", USERS.admin)).json()) as { items: { occurred_at: string }[] };
  const ahead = Date.parse(newest.items[0]?.occurred_at ?? "") - Date.now();
  if (ahead > 0) await page.waitForTimeout(Math.min(ahead + 1000, 60_000));
  const file = async (name: string, purpose: string, days: number) => {
    const p = (await (await call("post", "/projects", MOCK_USERS.aSteward, { name, description: "알림 시연" })).json()) as { project_id: string };
    const r = await call("post", "/access-requests", MOCK_USERS.aSteward, {
      dataset_id: DATASET_BATTERY,
      project_id: p.project_id,
      purpose,
      purpose_detail: "배터리 셀 열화 패턴을 비교 분석하기 위해 사이클 데이터를 사용합니다.",
      operations: ["READ"],
      requested_days: days,
    });
    return ((await r.json()) as { access_request_id: string }).access_request_id;
  };
  const approved = await file("셀 열화 비교", "ACADEMIC_RESEARCH", 30);
  const rejected = await file("상용 모델 학습", "AI_TRAINING", 90);
  const changes = await file("충전 프로토콜 연구", "ACADEMIC_RESEARCH", 60);
  await call("post", `/access-requests/${approved}/approve`, USERS.steward, { grant_days: 30, operations: ["READ"] });
  await call("post", `/access-requests/${rejected}/reject`, USERS.steward, { reason: "상용 목적 학습은 이 데이터의 이용 조건에 맞지 않습니다." });
  await call("post", `/access-requests/${changes}/request-changes`, USERS.steward, { comment: "분석할 셀 범위와 기간을 구체적으로 적어 주세요." });
  const shared = (await (await call("post", "/projects", MOCK_USERS.bResearcher, { name: "공동 전해질 연구", description: "B 기관 주관" })).json()) as { project_id: string };
  await call("post", `/projects/${shared.project_id}/members`, MOCK_USERS.bResearcher, { user_id: MOCK_USERS.aSteward, role: "RESEARCHER" });
  await call("post", `/dataset-versions/${SENSORS_VERSION}/download-session`, MOCK_USERS.bResearcher, { project_id: shared.project_id });
}

test.describe("task 10 screens", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "chromium", "screenshots once"));

  test("activity timeline and the open notification popover", async ({ page, baseURL }) => {
    await seedTask10(page, baseURL!);
    await as(page, "admin", baseURL!);
    await page.goto("/commons/activity");
    await expect(page.getByRole("heading", { level: 1, name: "활동 · 감사 로그" })).toBeVisible();
    await expect(page.getByText("다운로드가 거부되었습니다").first()).toBeVisible();
    await shoot(page, `${T10}-activity`);

    await page.context().clearCookies();
    await page.context().addCookies([{ name: "nais_mock_user", value: MOCK_USERS.aSteward, url: baseURL! }]);
    for (const theme of ["light", "dark"] as Theme[]) {
      await setup(page, [1440, 900], theme);
      await page.goto("/commons/access");
      await page.getByRole("button", { name: /^알림/ }).click();
      await expect(page.getByRole("dialog", { name: "알림" })).toBeVisible();
      await shootOne(page, `${T10}-notifications-open`, 1440, theme);
      await page.keyboard.press("Escape");
    }
    await setup(page, [390, 844], "light");
    await page.goto("/commons/access");
    await page.getByRole("button", { name: /^알림/ }).click();
    await expect(page.getByRole("dialog", { name: "알림" })).toBeVisible();
    await shootOne(page, `${T10}-notifications-open`, 390, "light");
  });
});

test.describe("settings and organization (Task 11)", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "chromium", "screenshots once"));
  const prefix = process.env.SHOTS_PREFIX ?? "task11";

  test("settings", async ({ page, baseURL }) => {
    await as(page, "researcher", baseURL!);
    await page.goto("/settings");
    await expect(page.getByRole("heading", { level: 1, name: "설정" })).toBeVisible();
    await expect(page.getByLabel("국가연구자번호 (NTIS)")).toBeVisible();
    await shoot(page, `${prefix}-settings`);
  });

  test("organization admin", async ({ page, baseURL }) => {
    await as(page, "bAdmin", baseURL!);
    await page.goto("/settings/organization");
    await expect(page.getByRole("heading", { name: "멤버" })).toBeVisible();
    await expect(page.getByText("최유진").first()).toBeVisible();
    await shoot(page, `${prefix}-organization-admin`);
  });

  test("organization as platform admin (transfer)", async ({ page, baseURL }) => {
    await as(page, "admin", baseURL!);
    await page.goto("/settings/organization");
    await expect(page.getByRole("region", { name: "기관 이동" })).toBeVisible();
    await shoot(page, `${prefix}-organization-platform`);
  });

  test("organization overlays: row menu, role dialog", async ({ page, baseURL }) => {
    await as(page, "bAdmin", baseURL!);
    for (const theme of ["light", "dark"] as Theme[]) {
      await setup(page, [1440, 900], theme);
      await page.goto("/settings/organization");
      await page.getByRole("button", { name: "정현우 관리" }).first().click();
      await expect(page.getByRole("menu")).toBeVisible();
      await shootOne(page, `${prefix}-member-menu`, 1440, theme);
      await page.getByRole("menuitem", { name: "역할 변경" }).click();
      await expect(page.getByRole("dialog", { name: "정현우 역할 변경" })).toBeVisible();
      await shootOne(page, `${prefix}-roles-dialog`, 1440, theme);
      await page.keyboard.press("Escape");
    }
  });
});

test.describe("dashboard and error pages (Task 12)", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "chromium", "screenshots once"));
  const prefix = process.env.SHOTS_PREFIX ?? "task12";

  test("dashboard", async ({ page, baseURL }) => {
    await as(page, "steward", baseURL!);
    await page.goto("/commons");
    await expect(page.getByRole("heading", { level: 1, name: "대시보드" })).toBeVisible();
    await shoot(page, `${prefix}-dashboard`);
    await page.context().clearCookies();
    await as(page, "researcher", baseURL!);
    await page.goto("/commons");
    await expect(page.getByRole("heading", { level: 1, name: "대시보드" })).toBeVisible();
    await shoot(page, `${prefix}-dashboard-researcher`, [[1440, 900]]);
  });

  test("not-found and blocked", async ({ page, baseURL }) => {
    await as(page, "researcher", baseURL!);
    await page.goto("/commons/no-such-page");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await shoot(page, `${prefix}-not-found`);
    await page.goto("/blocked?code=MEMBERSHIP_DISABLED");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await shoot(page, `${prefix}-blocked`, [[1440, 900]]);
  });
});

// UI v2 (Track C): access management and activity. V2_PHASE=before|after names the set: v2-access-<screen>-<phase>-<w>-<theme>.png.
test.describe("v2 track C screens", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "chromium", "screenshots once"));
  const phase = process.env.V2_PHASE ?? "after";

  test("access", async ({ page, baseURL }) => {
    await seedTask10(page, baseURL!);
    const id = await seedReviewQueue(page, baseURL!);
    await as(page, "steward", baseURL!);
    await page.goto("/commons/access");
    await expect(page.getByText("김민준").first()).toBeVisible();
    await shoot(page, `v2-access-review-${phase}`);
    await page.goto(`/commons/access/${id}`);
    await expect(page.getByRole("button", { name: "승인" }).first()).toBeVisible();
    await shoot(page, `v2-access-detail-${phase}`);
    await page.goto("/commons/access?tab=org-grants");
    await expect(page.getByRole("tab", { name: "기관 권한" })).toHaveAttribute("aria-selected", "true");
    await page.waitForLoadState("networkidle");
    await shoot(page, `v2-access-org-grants-${phase}`, [[1440, 900]]);

    await page.context().clearCookies();
    await as(page, "researcher", baseURL!);
    await page.goto("/commons/access");
    await expect(page.getByRole("link", { name: "리튬이온 배터리 셀 사이클 시험 데이터" }).first()).toBeVisible();
    await shoot(page, `v2-access-requests-${phase}`, [[1440, 900]]);
    await page.goto("/commons/access?tab=grants");
    await expect(page.getByRole("link", { name: "다운로드" }).first()).toBeVisible();
    await shoot(page, `v2-access-grants-${phase}`);
    await page.goto("/commons/access/00000000-0000-7000-8000-000000003001");
    await expect(page.getByRole("link", { name: "다운로드" })).toBeVisible();
    await shoot(page, `v2-access-detail-requester-${phase}`, [[1440, 900]]);
  });

  test("activity and notifications", async ({ page, baseURL }) => {
    await seedTask10(page, baseURL!);
    await as(page, "admin", baseURL!);
    await page.goto("/commons/activity");
    await expect(page.getByText("다운로드가 거부되었습니다").first()).toBeVisible();
    await shoot(page, `v2-activity-${phase}`);
    await page.context().clearCookies();
    await page.context().addCookies([{ name: "nais_mock_user", value: MOCK_USERS.aSteward, url: baseURL! }]);
    for (const theme of ["light", "dark"] as Theme[]) {
      await setup(page, [1440, 900], theme);
      await page.goto("/commons/activity");
      await page.getByRole("button", { name: /^알림/ }).click();
      await expect(page.getByRole("dialog", { name: "알림" })).toBeVisible();
      await shootOne(page, `v2-activity-notifications-${phase}`, 1440, theme);
      await page.keyboard.press("Escape");
    }
    await setup(page, [390, 844], "light");
    await page.goto("/commons/activity");
    await page.getByRole("button", { name: /^알림/ }).click();
    await expect(page.getByRole("dialog", { name: "알림" })).toBeVisible();
    await shootOne(page, `v2-activity-notifications-${phase}`, 390, "light");
  });
});
