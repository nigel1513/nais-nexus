import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const A_RESEARCHER = "00000000-0000-7000-8000-000000000a02";

async function seriousViolations(page: import("@playwright/test").Page, include?: string) {
  const builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  const results = await (include ? builder.include(include) : builder).analyze();
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

test("dataset form: sections, pickers and the edit sheet pass axe in both themes and work by keyboard", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "nais_mock_user", value: "00000000-0000-7000-8000-000000000b03", url: baseURL! }]);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/commons/data/new");
    await expect(page.getByRole("heading", { level: 1, name: "데이터셋 등록" })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);

    const pi = page.getByRole("combobox", { name: /연구책임자/ });
    await pi.fill("B R");
    await expect(page.getByRole("option", { name: /B Researcher/ })).toBeVisible();
    // Base UI's combobox marks everything outside the input and list aria-hidden while the list is open (its
    // FloatingFocusManager runs modal when the input sits outside the popup), which axe reports as aria-hidden-focus
    // on the page behind; it is lifted on close. Check the open list itself.
    expect(await seriousViolations(page, "[role=listbox]")).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(pi).toHaveValue("B Researcher (Institute B)");

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
    await expect(sheet.getByLabel(/^제목/)).toHaveValue("Battery Cycling Measurements");
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  }
});
