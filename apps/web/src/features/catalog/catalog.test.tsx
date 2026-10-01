import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { getDb } from "@/mocks/db";
import { DATASET, PROJECT, USER, VERSION } from "@/mocks/fixtures";
import { server } from "../../../tests/msw";
import { router, setLocation } from "../../../tests/navigation";
import { renderScreen } from "../../../tests/render";
import { DataSearchScreen } from "./data-search-screen";
import { DatasetDetailScreen } from "./dataset-detail-screen";
import { DatasetNewScreen } from "./dataset-new-screen";

describe("DataSearchScreen", () => {
  it("lists visible datasets with badges and filters via facets synced to the URL", async () => {
    renderScreen(<DataSearchScreen />, { user: USER.aResearcher, path: "/commons/data" });
    expect(await screen.findByRole("heading", { level: 2, name: "Battery Cycling Measurements" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Inst-B Internal QC Logs" })).not.toBeInTheDocument();
    expect(screen.getByText("총 4건")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "통제 (2)" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/commons/data?access_level=CONTROLLED", { scroll: false }));
    expect(await screen.findByText("총 2건")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Dataset 등록|데이터셋 등록/ })).not.toBeInTheDocument();
  });

  it("filters by subject facet and shows PI, period and subtitle on cards", async () => {
    renderScreen(<DataSearchScreen />, { user: USER.aResearcher, path: "/commons/data" });
    const card = (await screen.findByRole("heading", { level: 2, name: "Battery Cycling Measurements" })).closest("article")!;
    expect(within(card as HTMLElement).getByText("연료전지 고분자 막 시편 1,000개의 온도·압력 측정")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText(/B Researcher/)).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText(/2026-01-01 – 2026-01-01/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /^재료 \(/ }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/commons/data?subject=MATERIALS", { scroll: false }));
  });

  it("offers material and method facets with vocabulary labels", async () => {
    renderScreen(<DataSearchScreen />, { user: USER.aResearcher, path: "/commons/data" });
    expect(await screen.findByRole("group", { name: "소재" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "수집·분석 방법" })).toBeInTheDocument();
    const box = within(screen.getByRole("group", { name: "소재" })).getAllByRole("checkbox")[0]!;
    await userEvent.click(box);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(expect.stringMatching(/^\/commons\/data\?material=/), { scroll: false }));
  });

  it("applies a data-period filter and rejects an inverted range", async () => {
    renderScreen(<DataSearchScreen />, { user: USER.aResearcher, path: "/commons/data" });
    await userEvent.type(await screen.findByLabelText("기간 시작"), "2026-01-01");
    await userEvent.click(screen.getByRole("button", { name: "기간 적용" }));
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith("/commons/data?temporal_from=2026-01-01", { scroll: false }));
    await userEvent.type(screen.getByLabelText("기간 끝"), "2025-01-01");
    await userEvent.click(screen.getByRole("button", { name: "기간 적용" }));
    expect(await screen.findByText(/기간의 끝이 시작보다 빠릅니다/)).toBeInTheDocument();
  });

  it("shows the server 422 TEMPORAL_RANGE from an edited URL as a field error", async () => {
    renderScreen(<DataSearchScreen />, { user: USER.aResearcher, path: "/commons/data?temporal_from=2026-05-01&temporal_to=2025-01-01" });
    expect(await screen.findByText(/기간의 끝이 시작보다 빠릅니다/)).toBeInTheDocument();
    expect(screen.getByLabelText("기간 시작")).toHaveValue("2026-05-01");
    expect(screen.getByRole("status")).toHaveTextContent("데이터 기간을 바로잡으면 검색 결과가 표시됩니다.");
  });

  it("filters by principal investigator via the person picker", async () => {
    renderScreen(<DataSearchScreen />, { user: USER.aResearcher, path: "/commons/data" });
    await userEvent.type(await screen.findByRole("combobox", { name: "사용자 검색" }), "Researcher");
    await userEvent.click(await screen.findByRole("option", { name: /B Researcher/ }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(expect.stringMatching(/^\/commons\/data\?principal_investigator_id=/), { scroll: false }));
  });

  it("empty result offers a filter reset", async () => {
    renderScreen(<DataSearchScreen />, { user: USER.aResearcher, path: "/commons/data?q=zzzz" });
    expect(await screen.findByText("조건에 맞는 데이터가 없습니다.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    expect(router.replace).toHaveBeenLastCalledWith("/commons/data", { scroll: false });
    expect(await screen.findByText("총 4건")).toBeInTheDocument();
  });

  it("re-derives facets, sort and keyword from the URL on Back/Forward", async () => {
    renderScreen(<DataSearchScreen />, { user: USER.aResearcher, path: "/commons/data?access_level=CONTROLLED&q=battery&sort=title_asc" });
    const box = await screen.findByRole("searchbox", { name: "데이터 검색" });
    expect(box).toHaveValue("battery");
    expect(screen.getByLabelText("정렬")).toHaveValue("title_asc");
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /^통제/ })).toBeChecked());
    act(() => setLocation("/commons/data"));
    await waitFor(() => expect(box).toHaveValue(""));
    expect(screen.getByLabelText("정렬")).toHaveValue("relevance");
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /^통제/ })).not.toBeChecked());
  });

  it("loads more results with the cursor", async () => {
    const hit = (n: number) => ({ dataset_id: `00000000-0000-4000-8000-00000000000${n}`, title: `Hit ${n}`, access_level: "PUBLIC", owner_organization_id: "o", updated_at: "2026-09-01T00:00:00Z" });
    server.use(
      http.get("*/mock-api/v1/datasets", ({ request }) => {
        const second = new URL(request.url).searchParams.get("cursor") === "c1";
        return HttpResponse.json({ items: [hit(second ? 2 : 1)], page: { has_more: !second, next_cursor: second ? null : "c1", limit: 1 }, total: 2, facets: {} });
      }),
    );
    renderScreen(<DataSearchScreen />, { user: USER.aResearcher, path: "/commons/data" });
    expect(await screen.findByRole("heading", { level: 2, name: "Hit 1" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "더 보기" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Hit 2" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Hit 1" })).toBeInTheDocument();
  });

  it("keeps a selected facet value visible and toggleable with 0 hits", async () => {
    renderScreen(<DataSearchScreen />, { user: USER.aResearcher, path: "/commons/data?keyword=nonexistent-kw" });
    const box = await screen.findByRole("checkbox", { name: "nonexistent-kw (0)" });
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(router.replace).toHaveBeenLastCalledWith("/commons/data", { scroll: false });
  });

  it("DATA_STEWARD sees the register button", async () => {
    renderScreen(<DataSearchScreen />, { user: USER.bSteward, path: "/commons/data" });
    expect(await screen.findByRole("link", { name: "데이터셋 등록" })).toHaveAttribute("href", "/commons/data/new");
  });
});

describe("DatasetNewScreen", () => {
  it("non-stewards get the 403 notice", async () => {
    renderScreen(<DatasetNewScreen />, { user: USER.aResearcher, path: "/commons/data/new" });
    expect(await screen.findByRole("alert")).toHaveTextContent("이 작업을 수행할 권한이 없습니다.");
  });

  it("caps SENSITIVE at 30 days and creates the dataset for the steward's organization", async () => {
    renderScreen(<DatasetNewScreen />, { user: USER.aSteward, path: "/commons/data/new" });
    expect(await screen.findByText("Institute A")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^제목/), "Pilot Line Vibration");
    await userEvent.type(screen.getByLabelText(/^라이선스/), "NAIS-CONTROLLED-1.0");
    await userEvent.click(screen.getByRole("radio", { name: /민감/ }));
    const days = screen.getByLabelText(/^최대 이용 기간/);
    expect(days).toHaveAttribute("max", "30");
    expect(days).toHaveValue(30);
    await userEvent.click(screen.getByRole("checkbox", { name: "학술 연구" }));
    await userEvent.type(screen.getByRole("combobox", { name: /연구책임자/ }), "A R");
    await userEvent.click(await screen.findByRole("option", { name: /A Researcher/ }));
    await userEvent.click(screen.getByRole("button", { name: "데이터셋 등록" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/commons\/data\/[0-9a-f-]{36}\?created=1$/)));
    expect(getDb().datasets.find((d) => d.title === "Pilot Line Vibration")?.policy).toMatchObject({ access_level: "SENSITIVE", max_grant_days: 30 });
  });
});

describe("DatasetDetailScreen", () => {
  const open = (user: string, datasetId: string, query = "") =>
    renderScreen(<DatasetDetailScreen datasetId={datasetId} />, { user, path: `/commons/data/${datasetId}${query}` });

  it("grant holder gets a download CTA with expiry", async () => {
    open(USER.aResearcher, DATASET.battery);
    const cta = await screen.findByRole("link", { name: "다운로드" });
    expect(cta).toHaveAttribute("href", `/commons/data/${DATASET.battery}/versions/${VERSION.battery}?download=1`);
    expect(screen.getAllByText(/후 만료/).length).toBeGreaterThan(0);
    expect(screen.getByText(/환경 챔버\(모델 EC-200\)/)).toBeInTheDocument();
  });

  it("requests access through the dialog (allowed purposes only, SENSITIVE ≤ 30 days)", async () => {
    open(USER.aResearcher, DATASET.sensors);
    await userEvent.click(await screen.findByRole("button", { name: "접근 요청" }));
    const dialog = await screen.findByRole("dialog", { name: "접근 요청" });
    const purpose = within(dialog).getByLabelText(/^이용 목적/);
    expect(within(purpose).getAllByRole("option").map((o) => o.textContent)).toEqual(["학술 연구"]);
    expect(within(dialog).getByRole("checkbox", { name: /읽기/ })).toBeDisabled();
    expect(within(dialog).getByLabelText(/^이용 기간/)).toHaveAttribute("max", "30");
    await userEvent.type(within(dialog).getByLabelText(/^목적 상세/), "짧음");
    await userEvent.click(within(dialog).getByRole("button", { name: "요청 보내기" }));
    expect((await within(dialog).findAllByText(/20자 이상 4000자 이하/)).length).toBeGreaterThan(0);
    await userEvent.selectOptions(within(dialog).getByLabelText(/^프로젝트/), PROJECT.seed);
    await userEvent.type(within(dialog).getByLabelText(/^목적 상세/), "을 보완한 시설 온도 영향 비교 분석 연구 계획입니다.");
    await userEvent.click(within(dialog).getByRole("button", { name: "요청 보내기" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/commons\/access\/[0-9a-f-]{36}$/)));
  });

  it("open request → view request link", async () => {
    const send = async (path: string, body: unknown) => {
      const res = await fetch(`http://localhost:3000/mock-api/v1${path}`, { method: "POST", headers: { "content-type": "application/json", "x-mock-user": USER.bResearcher }, body: JSON.stringify(body) });
      expect(res.status).toBe(201);
      return res.json();
    };
    const project = await send("/projects", { name: "B Study", description: "B 기관 연구" });
    const request = await send("/access-requests", {
      dataset_id: DATASET.sensors,
      project_id: project.project_id,
      purpose: "ACADEMIC_RESEARCH",
      purpose_detail: "센서 스트림 분석을 위한 충분히 긴 목적 상세 설명입니다.",
      operations: ["READ"],
      requested_days: 30,
    });
    open(USER.bResearcher, DATASET.sensors);
    expect(await screen.findByRole("link", { name: "요청 상태 보기" })).toHaveAttribute("href", `/commons/access/${request.access_request_id}`);
    expect(screen.queryByRole("button", { name: "접근 요청" })).not.toBeInTheDocument();
  });

  it("PUBLIC data needs no request: download link, no request button", async () => {
    open(USER.aResearcher, DATASET.openMaterials);
    expect(await screen.findByRole("link", { name: "다운로드" })).toHaveAttribute("href", `/commons/data/${DATASET.openMaterials}/versions/${VERSION.openMaterials}?download=1`);
    expect(screen.queryByRole("button", { name: "접근 요청" })).not.toBeInTheDocument();
  });

  it("INTERNAL data of another organization is not found (unified 404)", async () => {
    open(USER.aResearcher, DATASET.qcLogs);
    expect(await screen.findByRole("alert")).toHaveTextContent("찾을 수 없거나 접근 권한이 없습니다.");
  });

  it("a project VIEWER cannot request access (D-031): the dialog explains instead of offering a form", async () => {
    for (const m of getDb().projectMembers.filter((x) => x.user_id === USER.aResearcher)) m.role = "VIEWER";
    open(USER.aResearcher, DATASET.sensors);
    await userEvent.click(await screen.findByRole("button", { name: "접근 요청" }));
    const dialog = await screen.findByRole("dialog", { name: "접근 요청" });
    expect(within(dialog).getByText(/열람자 역할로는 요청할 수 없습니다/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "요청 보내기" })).not.toBeInTheDocument();
  });

  it("a duplicate open request error links to the existing request", async () => {
    server.use(
      http.post("*/mock-api/v1/access-requests", () =>
        HttpResponse.json({ error: { code: "ACCESS_REQUEST_DUPLICATE", message: "dup", trace_id: "t", details: { access_request_id: "11111111-1111-4111-8111-111111111111" } } }, { status: 409 }),
      ),
    );
    open(USER.aResearcher, DATASET.sensors);
    await userEvent.click(await screen.findByRole("button", { name: "접근 요청" }));
    const dialog = await screen.findByRole("dialog", { name: "접근 요청" });
    await userEvent.selectOptions(within(dialog).getByLabelText(/^프로젝트/), PROJECT.seed);
    await userEvent.type(within(dialog).getByLabelText(/^목적 상세/), "충분히 길게 작성한 목적 상세 설명입니다. 비교 분석 연구.");
    await userEvent.click(within(dialog).getByRole("button", { name: "요청 보내기" }));
    expect(await within(dialog).findByRole("link", { name: "기존 요청 보기" })).toHaveAttribute("href", "/commons/access/11111111-1111-4111-8111-111111111111");
  });

  it("DRAFT versions are listed only for the owner organization's steward", async () => {
    getDb().datasets.find((d) => d.dataset_id === DATASET.electrolyte)!.access_level = "PUBLIC";
    const { unmount } = open(USER.aResearcher, DATASET.electrolyte, "?tab=versions");
    await screen.findByRole("heading", { level: 1, name: "Electrolyte Screening (draft)" });
    expect(screen.queryByText("초안")).not.toBeInTheDocument();
    unmount();
    open(USER.aSteward, DATASET.electrolyte, "?tab=versions");
    await screen.findByRole("heading", { level: 1, name: "Electrolyte Screening (draft)" });
    expect(await screen.findByText("초안")).toBeInTheDocument();
  });

  it("ACCESS_NOT_REQUIRED from the server switches the CTA to download", async () => {
    server.use(http.post("*/mock-api/v1/access-requests", () => HttpResponse.json({ error: { code: "ACCESS_NOT_REQUIRED", message: "n", trace_id: "t" } }, { status: 422 })));
    open(USER.aResearcher, DATASET.sensors);
    await userEvent.click(await screen.findByRole("button", { name: "접근 요청" }));
    const dialog = await screen.findByRole("dialog", { name: "접근 요청" });
    await userEvent.selectOptions(within(dialog).getByLabelText(/^프로젝트/), PROJECT.seed);
    await userEvent.type(within(dialog).getByLabelText(/^목적 상세/), "충분히 길게 작성한 목적 상세 설명입니다. 비교 분석 연구.");
    await userEvent.click(within(dialog).getByRole("button", { name: "요청 보내기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "접근 요청" })).not.toBeInTheDocument();
  });

  it("maps server VALIDATION_FAILED onto the request dialog fields with localized reasons", async () => {
    server.use(
      http.post("*/mock-api/v1/access-requests", () =>
        HttpResponse.json({ error: { code: "VALIDATION_FAILED", message: "v", trace_id: "t", details: { fields: [{ field: "purpose_detail", reason: "TOO_LONG" }] } } }, { status: 422 }),
      ),
    );
    open(USER.aResearcher, DATASET.sensors);
    await userEvent.click(await screen.findByRole("button", { name: "접근 요청" }));
    const dialog = await screen.findByRole("dialog", { name: "접근 요청" });
    await userEvent.selectOptions(within(dialog).getByLabelText(/^프로젝트/), PROJECT.seed);
    await userEvent.type(within(dialog).getByLabelText(/^목적 상세/), "충분히 길게 작성한 목적 상세 설명입니다. 비교 분석 연구.");
    await userEvent.click(within(dialog).getByRole("button", { name: "요청 보내기" }));
    expect(await within(dialog).findByText("너무 깁니다.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^목적 상세/)).toHaveAttribute("aria-invalid", "true");
  });

  it("editing cannot silently clear a previously set optional field", async () => {
    let patches = 0;
    server.use(http.patch("*/mock-api/v1/datasets/:id", () => { patches += 1; return HttpResponse.json({}); }));
    open(USER.bSteward, DATASET.battery);
    await userEvent.click(await screen.findByRole("button", { name: "편집" }));
    await userEvent.clear(screen.getByLabelText(/^이용 정책/));
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findAllByText(/이 항목은 비울 수 없습니다/)).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/^이용 정책/)).toHaveAttribute("aria-invalid", "true");
    expect(patches).toBe(0);
  });

  it("owner-org steward can change policy only after the non-retroactive warning", async () => {
    open(USER.bSteward, DATASET.battery);
    await userEvent.click(await screen.findByRole("button", { name: "편집" }));
    const days = screen.getByLabelText(/^최대 이용 기간/);
    await userEvent.clear(days);
    await userEvent.type(days, "90");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("기존 권한에는 소급 적용되지 않습니다");
    await userEvent.click(within(dialog).getByRole("button", { name: "변경" }));
    await waitFor(() => expect(getDb().datasets.find((d) => d.dataset_id === DATASET.battery)?.policy.max_grant_days).toBe(90));
  });

  it("typing over the PI without picking reverts to the current person on blur", async () => {
    const piBefore = getDb().datasets.find((d) => d.dataset_id === DATASET.battery)?.principal_investigator_id;
    open(USER.bSteward, DATASET.battery);
    await userEvent.click(await screen.findByRole("button", { name: "편집" }));
    const pi = screen.getByRole("combobox", { name: /연구책임자/ });
    const original = (pi as HTMLInputElement).value;
    expect(original).not.toBe("");
    await userEvent.type(pi, "zz");
    expect(pi).toHaveValue(`${original}zz`);
    await userEvent.tab();
    expect(pi).toHaveValue(original);
    await userEvent.clear(screen.getByLabelText(/^제목/));
    await userEvent.type(screen.getByLabelText(/^제목/), "Renamed Battery");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(getDb().datasets.find((d) => d.dataset_id === DATASET.battery)?.title).toBe("Renamed Battery"));
    expect(getDb().datasets.find((d) => d.dataset_id === DATASET.battery)?.principal_investigator_id).toBe(piBefore);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not ask for the policy confirmation again when retrying after a contributors failure", async () => {
    let puts = 0;
    server.use(http.put("*/mock-api/v1/datasets/:id/contributors", () => { puts += 1; return puts === 1 ? HttpResponse.json({ code: "INTERNAL_ERROR", message: "boom", details: {} }, { status: 500 }) : HttpResponse.json({ items: [] }); }));
    open(USER.bSteward, DATASET.battery);
    await userEvent.click(await screen.findByRole("button", { name: "편집" }));
    const days = screen.getByLabelText(/^최대 이용 기간/);
    await userEvent.clear(days);
    await userEvent.type(days, "90");
    await userEvent.type(screen.getByRole("combobox", { name: "공동연구자 검색" }), "B R");
    await userEvent.click(await screen.findByRole("option", { name: /B Researcher/ }));
    await userEvent.click(screen.getByRole("button", { name: "추가" }));
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "변경" }));
    await waitFor(() => expect(puts).toBe(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(puts).toBe(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
