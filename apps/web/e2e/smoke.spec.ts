import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const A_RESEARCHER = "00000000-0000-7000-8000-000000000a02";

/** `within`: check only an open overlay; the page behind it is covered, which axe reads as obscured targets. */
async function seriousViolations(page: import("@playwright/test").Page, within?: string) {
  // Entrance animations fade content in; checking contrast mid-fade reports text that is about to be fully opaque.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity));
  const builder = new AxeBuilder({ page });
  if (within) builder.include(within);
  const results = await builder.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help}`);
}

test("public landing renders the portal (not the gateway 503)", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("함께 연구합니다");
  const sso = page.getByRole("link", { name: "NST 통합 로그인 (SSO)", exact: true }).first();
  await expect(sso).toHaveAttribute("href", "/commons");
  await expect(page.getByText("접속 기록이 감사 로그에 남습니다.")).toBeVisible();
  // Scroll like a reader so every once-only reveal fires, then let the 700ms transitions settle before axe.
  for (let i = 0; i < 16; i += 1) {
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(80);
  }
  await expect(page.locator(".lp-reveal[data-pre]")).toHaveCount(0);
  await page.waitForTimeout(1200);
  expect(await seriousViolations(page)).toEqual([]);
  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
    expect(await seriousViolations(page)).toEqual([]);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await sso.click();
  await expect(page).toHaveURL(/\/mock-login\?callbackUrl=%2Fcommons$/);
  await expect(page.getByRole("heading", { level: 1, name: "계정 선택" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await seriousViolations(page)).toEqual([]);
});

test("mock login → dashboard → data search show mock data", async ({ page }) => {
  await page.goto("/commons");
  await expect(page).toHaveURL(/\/mock-login\?callbackUrl=%2Fcommons$/);
  await page.getByLabel("사용자").selectOption(A_RESEARCHER);
  await page.getByRole("button", { name: "로그인" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "대시보드" })).toBeVisible();
  await expect(page.getByRole("link", { name: "리튬이온 배터리 셀 사이클 시험 데이터" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "알림 1개 읽지 않음" })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "전체 데이터", exact: true }).click();
  await expect(page).toHaveURL(/\/commons\/data$/);
  await expect(page.getByRole("heading", { level: 3, name: "리튬이온 배터리 셀 사이클 시험 데이터" })).toBeVisible();
  await expect(page.getByText("총 12건")).toBeVisible();
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
  await expect(page.getByRole("link", { name: "리튬이온 배터리 셀 사이클 시험 데이터" }).first()).toBeVisible();
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
  await context.addCookies([{ name: "nais_mock_user", value: "00000000-0000-7000-8000-000000000b02", url: baseURL! }]); // 최유진 (owner organization)
  await page.goto(`/commons/data/${BATTERY}`);
  await expect(page.getByRole("heading", { level: 1, name: "리튬이온 배터리 셀 사이클 시험 데이터" })).toBeVisible();
  await expect(page.getByRole("button", { name: /AI-ready/ })).toBeVisible();
  await page.getByRole("button", { name: "Compact" }).click();
  await expect(page.getByRole("table", { name: /미리보기/ })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("region", { name: "메타데이터" }).getByRole("button", { name: "JSON-LD" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.jsonld$/);
  expect(await seriousViolations(page)).toEqual([]);
  await expect(page.getByText("DEPENDENCY_UNAVAILABLE")).toHaveCount(0);
});

test("Data Card: a visitor without permission sees the gated notice", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "nais_mock_user", value: "00000000-0000-7000-8000-000000000a01", url: baseURL! }]); // 박지훈, no grant
  await page.goto(`/commons/data/${BATTERY}`);
  await page.getByRole("button", { name: "Detail" }).click();
  await expect(page.getByText("접근 승인 후 미리보기 가능")).toBeVisible();
});

test("Settings: NTIS number saves, rejects a duplicate and can be cleared", async ({ page, context, baseURL }, info) => {
  // Both projects share one mock server: each uses its own user (박지훈 / 한유나, no number yet) and number so a
  // parallel run cannot clear the other's number mid-test.
  const insecure = info.project.name === "chromium-insecure-origin";
  const user = insecure ? "00000000-0000-7000-8000-000000000b01" : "00000000-0000-7000-8000-000000000a01";
  await context.addCookies([{ name: "nais_mock_user", value: user, url: baseURL! }]);
  await page.goto("/settings");
  const input = page.getByLabel("국가연구자번호 (NTIS)");
  await input.fill(insecure ? "12345679" : "12345678");
  await page.getByRole("button", { name: "번호 저장" }).click();
  await expect(page.getByText("저장했습니다.")).toBeVisible();
  await input.fill("10000002"); // 최유진's number in the seed
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
    expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /김민준/ }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "메뉴" }).click();
    const sheet = page.getByRole("dialog", { name: "메뉴" });
    await expect(sheet).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await sheet.getByRole("link", { name: "전체 데이터", exact: true }).click();
    await expect(page).toHaveURL(/\/commons\/data$/);
    await expect(sheet).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});

test("dataset form: sections, pickers and the edit sheet pass axe in both themes and work by keyboard", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "nais_mock_user", value: "00000000-0000-7000-8000-000000000b03", url: baseURL! }]);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/commons/data/new");
    await expect(page.getByRole("heading", { level: 1, name: "데이터셋 등록" })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);

    const pi = page.getByRole("combobox", { name: /연구책임자/ });
    await pi.fill("최유진");
    await expect(page.getByRole("option", { name: /최유진/ })).toBeVisible();
    // Base UI's combobox marks everything outside the input and list aria-hidden while the list is open (its
    // FloatingFocusManager runs modal when the input sits outside the popup), which axe reports as aria-hidden-focus
    // on the page behind; it is lifted on close. Check the open list itself.
    expect(await seriousViolations(page, "[role=listbox]")).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("group", { name: /연구책임자/ })).toContainText("최유진");

    await page.getByRole("button", { name: "연구 분야 선택" }).click();
    const vocab = page.getByRole("dialog", { name: "연구 분야" });
    await expect(vocab).toBeVisible();
    // Scoped to the popover: axe's target-size rule flags whatever input the popover half covers on the page behind.
    expect(await seriousViolations(page, "[role=dialog]")).toEqual([]);
    await vocab.getByRole("checkbox", { name: "재료" }).check();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("group", { name: "연구 분야" })).toContainText("재료");

    await page.getByRole("button", { name: "달력에서 기간 고르기" }).click();
    await expect(page.getByRole("grid")).toBeVisible();
    expect(await seriousViolations(page, "[role=dialog]")).toEqual([]);
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/commons/data/00000000-0000-7000-8000-000000002001");
    await page.getByRole("button", { name: "편집" }).click();
    const sheet = page.getByRole("dialog", { name: "데이터셋 편집" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByLabel(/^제목/)).toHaveValue("리튬이온 배터리 셀 사이클 시험 데이터");
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  }
});

test("projects: list, detail members and the actions menu pass axe in both themes; no sideways scroll at 390", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "nais_mock_user", value: A_RESEARCHER, url: baseURL! }]);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/commons/projects");
    await expect(page.getByRole("table", { name: "내 프로젝트" })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);

    await page.goto("/commons/projects/00000000-0000-7000-8000-000000001001/members");
    await expect(page.getByRole("form", { name: "구성원 초대" })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "프로젝트 작업 더 보기" }).click();
    await expect(page.getByRole("menuitem", { name: "보관…" })).toBeVisible();
    expect(await seriousViolations(page, "[role=menu]")).toEqual([]);
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});

test("data hub and the Data Card's 프로젝트 · 토론 · 이력 pass axe in both themes; no sideways scroll at 390", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "nais_mock_user", value: A_RESEARCHER, url: baseURL! }]);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/commons/hub");
    await expect(page.getByRole("heading", { level: 1, name: "데이터 허브" })).toBeVisible();
    await expect(page.getByRole("region", { name: "많이 쓰인 데이터" })).toBeVisible();
    await expect(page.getByRole("table", { name: "기관별 데이터 현황" })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/commons/data/00000000-0000-7000-8000-000000002001?tab=discussion");
    const discussion = page.getByRole("region", { name: "토론" });
    await discussion.getByRole("button", { name: /temp_c 주기적 상승 구간 확인 요청/ }).click();
    await expect(discussion.getByRole("textbox", { name: "답글" })).toBeVisible();
    await expect(page.getByRole("region", { name: "이 데이터를 쓴 프로젝트" }).getByRole("link", { name: "차세대 이차전지 소재 공동연구" })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "프로젝트에서 열기" }).click();
    await expect(page.getByRole("dialog", { name: "프로젝트에서 열기" })).toBeVisible();
    expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});

test("project workspace: tabs, recipe editor, output lineage and the 공개 요청 review pass axe in both themes; no sideways scroll at 390", async ({ page, context, baseURL }) => {
  const P = "/commons/projects/00000000-0000-7000-8000-000000001001";
  const RECIPE = "00000000-0000-7000-8000-000000005201";
  const OUTPUT = "00000000-0000-7000-8000-000000005401";
  const B_STEWARD = "00000000-0000-7000-8000-000000000b03";
  // A publish request for the seed output, so the steward's 공개 요청 tab has a row (a rerun on the same server finds it pending already).
  await page.goto("/");
  await page.evaluate(
    async ([user, path]) => {
      await fetch(`/mock-api/v1${path}`, { method: "POST", headers: { "x-mock-user": user, "content-type": "application/json" }, body: "{}" });
    },
    [A_RESEARCHER, `/projects/00000000-0000-7000-8000-000000001001/outputs/${OUTPUT}/publish-requests`],
  );
  await context.addCookies([{ name: "nais_mock_user", value: A_RESEARCHER, url: baseURL! }]);
  const narrow = async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(P);
    await expect(page.getByRole("navigation", { name: "프로젝트 작업 공간" })).toBeVisible();
    await expect(page.getByRole("region", { name: "최근 실행" }).first()).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await narrow();

    await page.goto(`${P}/data`);
    await expect(page.getByRole("table", { name: "입력 데이터" }).first()).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "데이터 추가" }).click();
    await expect(page.getByRole("dialog", { name: "데이터 추가" }).getByRole("radio").first()).toBeVisible();
    expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);
    await page.keyboard.press("Escape");
    await narrow();

    await page.goto(`${P}/recipes/${RECIPE}`);
    await expect(page.getByRole("region", { name: "변환 단계" })).toBeVisible();
    await page.getByRole("button", { name: "미리보기" }).click();
    await expect(page.getByRole("table", { name: "미리보기 결과" })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await narrow();

    await page.goto(`${P}/outputs/${OUTPUT}`);
    await expect(page.getByRole("img", { name: /데이터 계보/ })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await narrow();

    await page.goto(`${P}/discussion`);
    await expect(page.getByRole("button", { name: /배터리 입력을 v2.0으로 올릴지 논의/ })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await narrow();
  }

  await context.addCookies([{ name: "nais_mock_user", value: B_STEWARD, url: baseURL! }]);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/commons/access?tab=publish");
    await page.getByRole("button", { name: /검토$/ }).first().click();
    await expect(page.getByRole("dialog", { name: "허브 공개 검토" })).toBeVisible();
    expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);
    await page.keyboard.press("Escape");
    expect(await seriousViolations(page)).toEqual([]);
    await narrow();
  }
});

test("research notes: list, search, the standard form editor, sign dialog, verification and the project tab pass axe in both themes; no sideways scroll at 390", async ({ page, context, baseURL }) => {
  const P = "/commons/projects/00000000-0000-7000-8000-000000001001";
  const SIGNED = "00000000-0000-7000-8000-000000005701";
  const DRAFT = "00000000-0000-7000-8000-000000005702";
  await context.addCookies([
    { name: "nais_mock_user", value: A_RESEARCHER, url: baseURL! },
    { name: "nais_mock_auth_time", value: String(Date.now()), url: baseURL! },
  ]);
  const narrow = async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto("/commons/notes?q=18650");
    await expect(page.getByRole("heading", { level: 1, name: "연구노트" })).toBeVisible();
    await expect(page.getByRole("table", { name: "내 노트" })).toBeVisible();
    await expect(page.getByRole("region", { name: "검색 결과" }).getByRole("link").first()).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await narrow();

    await page.goto(`/commons/notes/${DRAFT}`);
    await expect(page.getByRole("table", { name: "노트 정보" })).toBeVisible();
    await expect(page.getByRole("group", { name: "연구 목표" }).getByRole("textbox").first()).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await narrow();
    // The sign dialog only describes what will be signed until 서명 is pressed (the draft stays a draft here).
    await page.getByRole("button", { name: /서명하고 확정|제출/ }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);
    await page.keyboard.press("Escape");

    await page.goto(`/commons/notes/${SIGNED}`);
    await page.getByRole("button", { name: "무결성 검증" }).click();
    await expect(page.getByRole("region", { name: "무결성 검증 결과" }).getByText("내용 해시 일치")).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await narrow();

    await page.goto(`${P}/notes`);
    await expect(page.getByRole("table", { name: "내 노트" })).toBeVisible();
    await expect(page.getByRole("region", { name: "확인자 설정" }).getByRole("switch")).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await narrow();
  }
});

test("notebooks: the 노트북 screen, the workspace 노트북 tab and the workspace button pass axe in both themes; no sideways scroll at 390", async ({ page, context, baseURL }) => {
  const PROJECT = "00000000-0000-7000-8000-000000001001";
  await context.addCookies([{ name: "nais_mock_user", value: A_RESEARCHER, url: baseURL! }]);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/commons/notebooks");
    await expect(page.getByRole("heading", { level: 1, name: "노트북" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "주 메뉴" });
    await expect(nav.getByRole("link", { name: "노트북", exact: true })).toHaveAttribute("aria-current", "page");
    // "노트북 열기" leads to the project's 노트북 tab (JupyterLab in a frame inside the portal).
    const open = page.getByRole("table", { name: "내 프로젝트" }).getByRole("link", { name: "차세대 이차전지 소재 공동연구 노트북 열기" });
    await expect(open).toHaveAttribute("href", `/commons/projects/${PROJECT}/notebook`);
    expect(await seriousViolations(page)).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("link", { name: /노트북 열기$/ }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(await seriousViolations(page)).toEqual([]);

    // No notebook server in the e2e stack: the tab explains it in place, with a retry.
    await page.goto(`/commons/projects/${PROJECT}/notebook`);
    const alert = page.getByRole("alert").filter({ hasText: "노트북 서버에 연결할 수 없습니다" });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("button", { name: "다시 시도" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(await seriousViolations(page)).toEqual([]);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/commons/projects/${PROJECT}`);
    await expect(page.getByRole("link", { name: "노트북 열기", exact: true })).toHaveAttribute("href", `/commons/projects/${PROJECT}/notebook`);
    expect(await seriousViolations(page)).toEqual([]);
  }
});

test("data search: rail, table view, empty result and the phone filter sheet pass axe in both themes", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "nais_mock_user", value: A_RESEARCHER, url: baseURL! }]);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/commons/data");
    const rail = page.getByRole("complementary", { name: "필터" });
    await expect(rail.getByRole("checkbox", { name: /^이차전지 \(/ })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);

    await page.getByRole("button", { name: "표" }).click();
    await expect(page).toHaveURL(/view=table/);
    await expect(page.getByRole("table", { name: "검색 결과" })).toBeVisible();
    // A client-side URL update can momentarily drop <title> while Next re-applies metadata; axe would flag that.
    await expect(page).toHaveTitle(/\S/);
    expect(await seriousViolations(page)).toEqual([]);

    await page.goto("/commons/data?q=zzzz");
    await expect(page.getByRole("button", { name: "필터 초기화" })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/commons/data");
    await page.getByRole("button", { name: "필터", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "필터" });
    await expect(sheet.getByRole("checkbox", { name: /^이차전지 \(/ })).toBeVisible();
    expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);
    await sheet.getByRole("checkbox", { name: /^이차전지 \(/ }).click();
    await expect(page).toHaveURL(/subject=BATTERY/);
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
  const row = page.getByRole("table", { name: "검토할 요청" }).getByRole("row").filter({ hasText: "이서연" }).first();
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

test("Settings and organization: axe clean in both themes, the theme choice persists, no sideways scroll at 390", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "nais_mock_user", value: "00000000-0000-7000-8000-000000000b01", url: baseURL! }]); // 한유나 (ORG_ADMIN)
  await page.goto("/settings");
  const theme = page.getByRole("radiogroup", { name: "화면 테마" });
  await expect(theme.getByRole("radio", { name: "시스템" })).toBeChecked();
  expect(await seriousViolations(page)).toEqual([]);
  await theme.getByRole("radio", { name: "다크" }).click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(page.getByRole("radiogroup", { name: "화면 테마" }).getByRole("radio", { name: "다크" })).toBeChecked();
  expect(await seriousViolations(page)).toEqual([]);

  await page.getByRole("navigation", { name: "설정 메뉴" }).getByRole("link", { name: "기관 관리" }).click();
  await expect(page.getByRole("table", { name: "기관 멤버" })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "정현우 관리" }).first().click();
  await expect(page.getByRole("menuitem", { name: "역할 변경" })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/settings", "/settings/organization"]) {
    await page.goto(path);
    await expect(page.getByRole("navigation", { name: "설정 메뉴" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});

test("Dashboard: steward and first-day views pass axe in both themes, the chart works by keyboard, no sideways scroll at 390", async ({ page, context, baseURL }) => {
  for (const [user, queue] of [
    ["00000000-0000-7000-8000-000000000b03", "검토할 요청"], // 정현우 (DATA_STEWARD)
    ["00000000-0000-7000-8000-000000009d03", "내 요청 진행"], // 문가영 (no requests, grants or downloads yet)
  ] as const) {
    await context.clearCookies();
    await context.addCookies([{ name: "nais_mock_user", value: user, url: baseURL! }]);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/commons");
      await expect(page.getByRole("heading", { level: 1, name: "대시보드" })).toBeVisible();
      await expect(page.getByRole("region", { name: new RegExp(`^${queue}`) })).toBeVisible();
      const chart = page.getByRole("slider", { name: /최근 30일 일별 건수/ });
      await expect(chart).toBeVisible();
      await expect(page.getByRole("region", { name: /데이터 상태/ }).getByRole("table")).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(await seriousViolations(page)).toEqual([]);
      await chart.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(chart).toHaveAttribute("aria-valuenow", "28");
      expect(await seriousViolations(page)).toEqual([]);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/commons");
    await expect(page.getByRole("region", { name: new RegExp(`^${queue}`) })).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});

test("version history: the 버전 tab and the new-draft dialog pass axe in both themes; no sideways scroll at 390", async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: "nais_mock_user", value: "00000000-0000-7000-8000-000000000b03", url: baseURL! }]);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/commons/data/00000000-0000-7000-8000-000000002001?tab=versions");
    await expect(page.getByRole("list", { name: "게시 이력" }).getByRole("listitem")).toHaveCount(3);
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "새 초안", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "새 초안" })).toBeVisible();
    expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(page.getByRole("list", { name: "게시 이력" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("draft page: banner, note-required publish dialog and discard; axe in both themes; no sideways scroll at 390", async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: "nais_mock_user", value: "00000000-0000-7000-8000-000000000b03", url: baseURL! }]);
  await page.goto("/commons/data/00000000-0000-7000-8000-000000002001?tab=versions");
  await page.getByRole("button", { name: "새 초안", exact: true }).click();
  const create = page.getByRole("dialog", { name: "새 초안" });
  // The mock store outlives one run: a unique label keeps reruns and both projects independent.
  await create.getByLabel(/^버전 이름/).fill(`v9.${Date.now().toString(36)}`);
  await create.getByRole("button", { name: "초안 만들기" }).click();
  await expect(page).toHaveURL(/\/versions\/[0-9a-f-]{36}$/);
  const banner = page.getByRole("region", { name: "초안 상태" });
  await expect(banner).toContainText("최신 버전 기준입니다");
  await expect(page.getByRole("table").getByText("이어받음").first()).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForLoadState("networkidle");
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "게시", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "버전 게시" });
    await dialog.getByRole("button", { name: "게시", exact: true }).click();
    await expect(dialog.getByText("변경 메모를 3자 이상 입력하세요")).toBeVisible();
    expect(await seriousViolations(page, '[role="dialog"]')).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await banner.getByRole("button", { name: "초안 삭제" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "삭제", exact: true }).click();
  await expect(page.getByText("초안을 삭제했습니다")).toBeVisible();
  await expect(page).toHaveURL(/\?tab=versions$/);
});
