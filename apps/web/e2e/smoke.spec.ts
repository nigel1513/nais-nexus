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

test("protected routes redirect with a relative Location and never reflect a forwarded host", async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "node-side request client cannot resolve the mapped test host");
  const res = await request.get("/commons/data?q=x", { maxRedirects: 0, headers: { "x-forwarded-host": "evil.example" } });
  expect(res.status()).toBe(307);
  expect(res.headers()["location"]).toBe("/mock-login?callbackUrl=%2Fcommons%2Fdata%3Fq%3Dx");
});

const BATTERY = "00000000-0000-7000-8000-000000002001";

test("Data Card: explorer, gated preview and JSON-LD download work on any origin", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "nais_mock_user", value: "00000000-0000-7000-8000-000000000b02", url: baseURL! }]); // B Researcher (owner organization)
  await page.goto(`/commons/data/${BATTERY}`);
  await expect(page.getByRole("heading", { level: 1, name: "Battery Cycling Measurements" })).toBeVisible();
  await expect(page.getByRole("button", { name: /AI-ready/ })).toBeVisible();
  await page.getByRole("radio", { name: "Compact" }).check();
  await expect(page.getByRole("table", { name: /미리보기/ })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("region", { name: "메타데이터" }).getByRole("button", { name: "JSON-LD" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.jsonld$/);
  expect(await seriousViolations(page)).toEqual([]);
  await expect(page.getByText("DEPENDENCY_UNAVAILABLE")).toHaveCount(0);
});

test("Data Card: a visitor without permission sees the gated notice", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "nais_mock_user", value: "00000000-0000-7000-8000-000000000a01", url: baseURL! }]); // A Admin, no grant
  await page.goto(`/commons/data/${BATTERY}`);
  await page.getByRole("radio", { name: "Detail" }).check();
  await expect(page.getByText("접근 승인 후 미리보기 가능")).toBeVisible();
});

test("Settings: NTIS number saves, rejects a duplicate and can be cleared", async ({ page, context, baseURL }, info) => {
  // Both projects share one mock server: each uses its own user (A Admin / B Admin, no number yet) and number so a
  // parallel run cannot clear the other's number mid-test.
  const insecure = info.project.name === "chromium-insecure-origin";
  const user = insecure ? "00000000-0000-7000-8000-000000000b01" : "00000000-0000-7000-8000-000000000a01";
  await context.addCookies([{ name: "nais_mock_user", value: user, url: baseURL! }]);
  await page.goto("/settings");
  const input = page.getByLabel("국가연구자번호 (NTIS)");
  await input.fill(insecure ? "12345679" : "12345678");
  await page.getByRole("button", { name: "번호 저장" }).click();
  await expect(page.getByText("저장했습니다.")).toBeVisible();
  await input.fill("10000002"); // B Researcher's number in the seed
  await page.getByRole("button", { name: "번호 저장" }).click();
  await expect(page.getByText("이미 다른 사용자가 등록한 번호입니다.")).toBeVisible();
  await page.getByRole("button", { name: "번호 삭제" }).click();
  await expect(page.getByRole("button", { name: "번호 삭제" })).toHaveCount(0);
  await expect(input).toHaveValue("");
});

test("ui gallery: primitives pass axe in both themes, menus work by keyboard, copy works on plain http", async ({ page }) => {
  await page.goto("/commons/_ui");
  await page.getByLabel("사용자").selectOption(A_RESEARCHER);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "UI 부품" })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  const light = page.locator('section[aria-labelledby="overlays-h"] .light');
  const trigger = light.getByRole("button", { name: "작업" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(trigger).toBeFocused();

  const select = page.locator('section[aria-labelledby="forms-h"] .light').getByRole("combobox", { name: "집계 단위 (SelectMenu)" });
  await select.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "월" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(select).toHaveText("월");

  await page.locator('section[aria-labelledby="data-h"] .light').getByRole("button", { name: "경로 복사" }).click();
  await expect(page.locator('section[aria-labelledby="data-h"] .light').getByText("복사했습니다")).toBeAttached();

  // PathText keeps the tail (file name / hash end) whole; only the head is ellipsized. 1440 and 390 wide.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const tails = page.locator('section[aria-labelledby="data-h"] .light [data-part="tail"]');
    await expect(tails.first()).toBeVisible();
    const clipped = await tails.evaluateAll((els) =>
      // Compare fractional widths: text-overflow ellipsis triggers on a sub-pixel overflow that scrollWidth rounds away.
      els
        .filter((e) => (e as HTMLElement).offsetParent)
        .map((e) => {
          const range = document.createRange();
          range.selectNodeContents(e);
          return { text: e.textContent, need: range.getBoundingClientRect().width, box: e.getBoundingClientRect().width };
        })
        .filter((x) => x.need > x.box + 0.01)
        .map((x) => `${x.text} ${x.need.toFixed(2)}>${x.box.toFixed(2)}`),
    );
    expect(clipped, `width ${width}`).toEqual([]);
  }

  await page.emulateMedia({ colorScheme: "dark" });
  expect(await seriousViolations(page)).toEqual([]);
});

test("shell: ⌘K, notifications, user menu and the phone sheet pass axe in both themes and work by keyboard", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "nais_mock_user", value: A_RESEARCHER, url: baseURL! }]);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/commons");
    await expect(page.getByRole("heading", { level: 1, name: "대시보드" })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);

    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "명령 팔레트" });
    await expect(palette).toBeVisible();
    await page.keyboard.type("활동");
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/commons\/activity$/);
    await expect(page.getByRole("navigation", { name: "현재 위치" })).toContainText("활동");

    await page.getByRole("button", { name: "알림 1개 읽지 않음" }).click();
    await expect(page.getByRole("dialog", { name: "알림" })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /A Researcher/ }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "메뉴" }).click();
    const sheet = page.getByRole("dialog", { name: "메뉴" });
    await expect(sheet).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await sheet.getByRole("link", { name: "데이터" }).click();
    await expect(page).toHaveURL(/\/commons\/data$/);
    await expect(sheet).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});

test("access: review queue and request detail pass axe in both themes, rows open by keyboard, no sideways scroll on a phone", async ({ page, context, baseURL }) => {
  const B_STEWARD = "00000000-0000-7000-8000-000000000b03";
  const A_STEWARD = "00000000-0000-7000-8000-000000000a03";
  // Seed from inside the page: the request context does not see the insecure project's host mapping.
  await page.goto("/");
  const id = await page.evaluate(async (user) => {
    const post = (path: string, body: unknown) =>
      fetch(`/mock-api/v1${path}`, { method: "POST", headers: { "x-mock-user": user, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const project = await post("/projects", { name: "Axe 접근 검토", description: "e2e" });
    const request = await post("/access-requests", {
      dataset_id: "00000000-0000-7000-8000-000000002001",
      project_id: project.project_id,
      purpose: "ACADEMIC_RESEARCH",
      purpose_detail: "접근성 점검을 위한 충분히 긴 목적 상세 설명입니다.",
      operations: ["READ"],
      requested_days: 30,
    });
    return request.access_request_id as string;
  }, A_STEWARD);
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  await context.addCookies([{ name: "nais_mock_user", value: B_STEWARD, url: baseURL! }]);

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/commons/access");
    await expect(page.getByRole("tab", { name: /검토할 요청/ })).toHaveAttribute("aria-selected", "true");
    const table = page.getByRole("table", { name: "검토할 요청" });
    await expect(table).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByRole("tab", { name: "내 권한" }).click();
    await expect(page).toHaveURL(/\?tab=grants$/);
    // A soft navigation re-renders the metadata; wait for <title> to come back before axe looks at it.
    await expect(page).toHaveTitle(/.+/);
    expect(await seriousViolations(page)).toEqual([]);

    await page.goto(`/commons/access/${id}`);
    await expect(page.getByRole("region", { name: "검토" }).getByRole("button", { name: "승인" })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  }

  await page.goto("/commons/access");
  const row = page.getByRole("table", { name: "검토할 요청" }).getByRole("row").filter({ hasText: "A Steward" }).first();
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/commons\/access\/[0-9a-f-]+$/);

  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/commons/access", `/commons/access/${id}`]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});

test("activity: the timeline and its action filter pass axe in both themes; no sideways scroll on a phone", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "nais_mock_user", value: "00000000-0000-7000-8000-000000000101", url: baseURL! }]);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/commons/activity");
    const timeline = page.getByRole("region", { name: "활동 목록" });
    await expect(timeline.getByRole("heading", { level: 2 }).first()).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "행동 종류" }).click();
    await expect(page.getByRole("checkbox", { name: "프로젝트 생성" })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await timeline.getByRole("button", { name: "상세 보기" }).first().click();
    await expect(timeline.getByText("추적 ID").first()).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/commons/activity");
  await expect(page.getByRole("region", { name: "활동 목록" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
