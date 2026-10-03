import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Task 16 end-to-end scenario on the mock API (NEXT_PUBLIC_API_MOCKING=enabled):
 * 허브 → 데이터 카드 → 프로젝트에서 열기 → 레시피 저장·실행 → 산출물 → 연구노트(오늘 노트, 표준 양식, AI 초안) → 제출 →
 * 기록자·확인자 서명 → 무결성 검증. Every screen is checked with axe (serious/critical) and for horizontal scroll at 390px.
 *
 * The project is created through the mock API so each run (and each Playwright project) starts clean. Jupyter (M07)
 * does not exist yet, so today's notebook is seeded through the mock-only hook POST /mock-api/test/notebook-activity
 * (404 unless mocking); the mock drafts deterministically and never calls an LLM.
 */

// Users whose notification counts no other spec asserts (the scenario's submit/sign notifications must not leak into
// the shell tests that expect 김민준's one unread notification; one mock server serves every spec).
const RESEARCHER = "00000000-0000-7000-8000-000000000b02"; // 최유진 (B 기관, owner organization of the battery data)
const WITNESS = "00000000-0000-7000-8000-000000000a01"; // 박지훈 (A 기관)
const BATTERY_TITLE = "리튬이온 배터리 셀 사이클 시험 데이터";

async function seriousViolations(page: Page, within?: string) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity));
  const builder = new AxeBuilder({ page });
  if (within) builder.include(within);
  const results = await builder.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
}

/** axe on the current screen, then no horizontal scroll at 390px, then back to the desktop width. */
async function checkScreen(page: Page, name: string) {
  expect(await seriousViolations(page), `${name}: axe`).toEqual([]);
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => window.innerWidth === 390); // the resize reached the page
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth), { message: `${name}: 390px horizontal scroll` }).toBeLessThanOrEqual(390);
  await page.setViewportSize(size);
}

async function login(page: Page, baseURL: string, user: string) {
  await page.context().addCookies([
    { name: "nais_mock_user", value: user, url: baseURL },
    // Signing needs a login within the last 5 minutes (mock-login sets this cookie).
    { name: "nais_mock_auth_time", value: String(Date.now()), url: baseURL },
  ]);
}

/** A mock API call from the page (same origin as the app, so it works on the insecure-origin project too). */
async function api<T>(page: Page, method: string, path: string, body?: unknown, user?: string): Promise<T> {
  const res = await page.evaluate(
    async ({ method, path, body, user }) => {
      const r = await fetch(path, { method, headers: { "content-type": "application/json", ...(user ? { "x-mock-user": user } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, text: await r.text() };
    },
    { method, path, body, user },
  );
  expect(res.status, `${method} ${path}: ${res.text}`).toBeLessThan(300);
  return (res.text ? JSON.parse(res.text) : undefined) as T;
}

const seoulDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());

test("허브 → 프로젝트 입력 → 레시피 실행 → 산출물 → 연구노트 서명·검증", async ({ page, baseURL }, info) => {
  test.setTimeout(180_000);
  await login(page, baseURL!, RESEARCHER);

  // ---- 허브
  await page.goto("/commons/hub");
  await expect(page.getByRole("heading", { level: 1, name: "데이터 허브" })).toBeVisible();
  const projectName = `e2e 연구 ${info.project.name} ${Date.now()}`;
  const project = await api<{ project_id: string }>(page, "POST", "/mock-api/v1/projects", { name: projectName, description: "통합 시나리오" });
  const pid = project.project_id;
  await api(page, "POST", `/mock-api/v1/projects/${pid}/members`, { user_id: WITNESS, role: "RESEARCHER" });
  await page.reload();
  await expect(page.getByRole("link", { name: BATTERY_TITLE }).first()).toBeVisible();
  await checkScreen(page, "hub");

  // ---- 데이터 카드 → 프로젝트에서 열기
  await page.getByRole("link", { name: BATTERY_TITLE }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: BATTERY_TITLE })).toBeVisible();
  await checkScreen(page, "data card");
  await page.getByRole("button", { name: "프로젝트에서 열기" }).click();
  const open = page.getByRole("dialog", { name: "프로젝트에서 열기" });
  await open.getByRole("radio", { name: new RegExp(projectName) }).click();
  expect(await seriousViolations(page, "[role=dialog]")).toEqual([]);
  await open.getByRole("button", { name: "입력으로 추가" }).click();
  await expect(open).toBeHidden();
  await expect(page.getByText(/에 입력으로 추가했습니다/)).toBeVisible();

  // ---- 작업 공간: 입력 → 새 레시피
  await page.goto(`/commons/projects/${pid}/data`);
  await expect(page.getByRole("link", { name: BATTERY_TITLE }).first()).toBeVisible();
  await checkScreen(page, "workspace data");
  await page.getByRole("navigation", { name: "프로젝트 작업 공간" }).getByRole("link", { name: "변환" }).click();
  await page.getByRole("button", { name: "새 레시피" }).first().click();
  const create = page.getByRole("dialog", { name: "새 레시피" });
  await create.getByLabel("레시피 이름").fill("고온 구간 용량");
  await create.getByRole("button", { name: "만들기" }).click();
  await expect(page).toHaveURL(new RegExp(`/commons/projects/${pid}/recipes/[0-9a-f-]{36}$`));

  // ---- 레시피: 단계 추가 → 저장 → 실행
  await expect(page.getByRole("region", { name: "변환 단계" })).toBeVisible();
  await page.getByLabel("단계 종류").selectOption("filter_rows");
  await page.getByRole("button", { name: "단계 추가" }).click();
  const steps = page.getByRole("region", { name: "변환 단계" });
  await steps.getByLabel("열", { exact: true }).fill("temp_c");
  await steps.getByLabel("값", { exact: true }).fill("25");
  await page.getByRole("button", { name: "미리보기" }).click();
  await expect(page.getByRole("table", { name: "미리보기 결과" })).toBeVisible();
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText(/레시피를 저장했습니다 \(v\d+\)\./)).toBeVisible();
  await checkScreen(page, "recipe editor");
  await page.getByRole("button", { name: "실행" }).click();
  const runs = page.getByRole("table", { name: "실행 기록" });
  const outputLink = runs.getByRole("link", { name: "산출물 보기" }).first();
  await expect(outputLink).toBeVisible({ timeout: 20_000 });
  await expect(runs.getByRole("row").nth(1)).toContainText("성공");

  // ---- 산출물
  await outputLink.click();
  await expect(page).toHaveURL(new RegExp(`/commons/projects/${pid}/outputs/[0-9a-f-]{36}$`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(BATTERY_TITLE).locator("visible=true").first()).toBeVisible(); // lineage reaches the input
  await checkScreen(page, "output detail");

  // ---- 연구노트: 확인자 설정 (프로젝트 책임자) → 오늘 노트
  await page.goto(`/commons/projects/${pid}/notes`);
  const settings = page.getByRole("region", { name: "확인자 설정" });
  await settings.getByRole("switch", { name: "제출한 노트에 확인자 서명 받기" }).click();
  await settings.getByRole("checkbox", { name: /박지훈/ }).click();
  await settings.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText("확인자 설정을 저장했습니다.")).toBeVisible();
  await checkScreen(page, "project notes tab");

  // Jupyter stand-in: one notebook saved today in this project.
  await api(page, "POST", "/mock-api/test/notebook-activity", {
    user_id: RESEARCHER,
    project_id: pid,
    day: seoulDate(),
    title: "45도 사이클 용량 분석",
    cells: [
      { type: "markdown", source_head: "# 45°C 사이클 용량 유지율 확인", output_kinds: [], output_count: 0, has_error: false },
      { type: "code", source_head: "df = pd.read_csv('cycle_45c.csv')", output_kinds: ["execute_result"], output_count: 1, has_error: false },
      { type: "code", source_head: "df.plot(x='cycle', y='retention')", output_kinds: ["display_data"], output_count: 1, has_error: false },
    ],
  });
  await page.getByRole("button", { name: "오늘 노트 쓰기" }).click();
  await expect(page).toHaveURL(/\/commons\/notes\/[0-9a-f-]{36}$/);
  const noteUrl = page.url();

  // 표준 양식: 사람이 쓴 문장 + AI 초안
  const objective = page.getByRole("group", { name: "연구 목표" });
  await objective.getByRole("button", { name: "연구 목표에 문장 추가" }).click();
  await objective.getByRole("textbox").first().fill("45°C 고온 사이클에서 용량 유지율 저하를 확인한다.");
  await expect(page.locator("[data-save-state]")).toHaveText(/저장됨/, { timeout: 10_000 });
  const draft = page.getByRole("button", { name: "AI 초안 만들기" });
  await expect(draft).toBeEnabled();
  await draft.click();
  const aiSentence = page.getByRole("group", { name: "수행 내용" }).getByRole("listitem", { name: /AI 초안/ }).first();
  await expect(aiSentence).toBeVisible({ timeout: 15_000 });
  await expect(aiSentence).toContainText("45도 사이클 용량 분석 · 셀 2");
  await expect(page.getByText(/검토하지 않은 AI 문장 \d+개/)).toBeVisible();
  await checkScreen(page, "note editor with AI draft");
  await page.getByRole("button", { name: "초안 확인 완료" }).click();
  await expect(page.getByText(/검토하지 않은 AI 문장/)).toHaveCount(0, { timeout: 10_000 });

  // 제출 → 기록자 서명
  await expect(page.getByRole("button", { name: "제출" })).not.toHaveAttribute("aria-disabled", "true");
  await page.getByRole("button", { name: "제출" }).click();
  const submit = page.getByRole("dialog", { name: "연구노트 제출" });
  expect(await seriousViolations(page, "[role=dialog]")).toEqual([]);
  await submit.getByRole("button", { name: "제출" }).click();
  await expect(page.locator("[data-note-status]")).toContainText("제출됨");
  await page.getByRole("button", { name: "서명", exact: true }).click();
  const sign = page.getByRole("dialog", { name: "연구노트 서명" });
  expect(await seriousViolations(page, "[role=dialog]")).toEqual([]);
  await sign.getByRole("button", { name: "서명" }).click();
  await expect(sign).toBeHidden();
  await checkScreen(page, "submitted note (recorder signed)");

  // ---- 확인자 서명
  await login(page, baseURL!, WITNESS);
  await page.goto(noteUrl);
  await page.getByRole("button", { name: "서명", exact: true }).click();
  const witnessSign = page.getByRole("dialog", { name: "연구노트 서명" });
  await expect(witnessSign).toContainText("확인자");
  await witnessSign.getByRole("button", { name: "서명" }).click();
  await expect(page.locator("[data-note-status]")).toContainText("서명 완료");
  const signatures = page.getByRole("table", { name: "서명" });
  await expect(signatures.getByRole("rowheader", { name: "확인자" })).toBeVisible();

  // ---- 무결성 검증
  await page.getByRole("button", { name: "무결성 검증" }).click();
  const verify = page.getByRole("region", { name: "무결성 검증 결과" });
  await expect(verify.getByText("내용 해시 일치")).toBeVisible();
  await expect(verify.getByText("체인 일치")).toBeVisible();
  await checkScreen(page, "signed note verified");
});
