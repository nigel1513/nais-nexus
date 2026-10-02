import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { getDb } from "@/mocks/db";
import { DATASET, GRANT, REQUEST, USER } from "@/mocks/fixtures";
import { server } from "../../../tests/msw";
import { router, setLocation } from "../../../tests/navigation";
import { renderScreen } from "../../../tests/render";
import { AccessRequestDetailScreen } from "./access-request-detail-screen";
import { AccessScreen } from "./access-screen";

const API = "http://localhost:3000/mock-api/v1";
const request = (id: string) => getDb().requests.find((r) => r.access_request_id === id)!;
const apiError = (status: number, code: string, details: Record<string, unknown> = {}) =>
  HttpResponse.json({ error: { code, message: code, details } }, { status });

/** The real seed has no pending request: 최유진 files one against A's sensor dataset through the mock API. */
async function seedPending(days = 14): Promise<string> {
  const send = async (path: string, body: unknown) => {
    const res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-mock-user": USER.bResearcher }, body: JSON.stringify(body) });
    expect(res.status).toBe(201);
    return res.json();
  };
  const project = await send("/projects", { name: "B Study", description: "B 기관 연구" });
  const r = await send("/access-requests", {
    dataset_id: DATASET.sensors,
    project_id: project.project_id,
    purpose: "ACADEMIC_RESEARCH",
    purpose_detail: "센서 스트림 분석을 위한 충분히 긴 목적 상세 설명입니다.",
    operations: ["READ"],
    requested_days: days,
  });
  return r.access_request_id;
}

describe("AccessScreen", () => {
  it("researcher: my requests and my grants, no reviewer tabs", async () => {
    renderScreen(<AccessScreen />, { user: USER.aResearcher, path: "/commons/access" });
    expect((await screen.findAllByRole("link", { name: "리튬이온 배터리 셀 사이클 시험 데이터" })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("tab", { name: /검토할 요청/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "기관 권한" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "내 권한" }));
    expect(router.replace).toHaveBeenCalledWith("/commons/access?tab=grants", { scroll: false });
    expect((await screen.findAllByRole("link", { name: "다운로드" }))[0]).toHaveAttribute("href", "/commons/data/00000000-0000-7000-8000-000000002001");
  });

  it("honours the dashboard links ?tab=grants and falls back for ?tab=review without the steward role", async () => {
    const { unmount } = renderScreen(<AccessScreen />, { user: USER.aResearcher, path: "/commons/access?tab=grants" });
    expect(await screen.findByRole("tab", { name: "내 권한" })).toHaveAttribute("aria-selected", "true");
    unmount();
    renderScreen(<AccessScreen />, { user: USER.aResearcher, path: "/commons/access?tab=review" });
    expect(await screen.findByRole("tab", { name: "내 요청" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: /검토할 요청/ })).not.toBeInTheDocument();
  });

  it("follows the URL on Back/Forward", async () => {
    renderScreen(<AccessScreen />, { user: USER.aResearcher, path: "/commons/access?tab=grants" });
    expect(await screen.findByRole("tab", { name: "내 권한" })).toHaveAttribute("aria-selected", "true");
    act(() => setLocation("/commons/access"));
    expect(await screen.findByRole("tab", { name: "내 요청" })).toHaveAttribute("aria-selected", "true");
    act(() => setLocation("/commons/access?tab=grants"));
    expect(await screen.findByRole("tab", { name: "내 권한" })).toHaveAttribute("aria-selected", "true");
  });

  it("highlights grants that expire within 7 days", async () => {
    renderScreen(<AccessScreen />, { user: USER.aResearcher, path: "/commons/access?tab=grants" });
    const expiry = await screen.findAllByText(/일 후 만료/);
    for (const e of expiry) expect(e).toHaveClass("text-warning");
  });

  it("steward: review tab shows the pending count", async () => {
    await seedPending();
    renderScreen(<AccessScreen />, { user: USER.aSteward, path: "/commons/access?tab=review" });
    expect(await screen.findByRole("tab", { name: "검토할 요청 (1건)" })).toHaveAttribute("aria-selected", "true");
    expect((await screen.findAllByText("시험동 공조 설비 센서 스트림")).length).toBeGreaterThan(0);
  });

  it("steward: the review queue is the first and default tab; rows show requester and organization and open the detail", async () => {
    const id = await seedPending();
    renderScreen(<AccessScreen />, { user: USER.aSteward, path: "/commons/access" });
    await screen.findByRole("tab", { name: "검토할 요청 (1건)" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["검토할 요청1", "내 요청", "내 권한", "기관 권한"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    const table = await screen.findByRole("table", { name: "검토할 요청" });
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["데이터셋", "요청자", "목적", "기간", "상태", "제출일"]);
    const row = within(table).getByText("최유진").closest("tr")!;
    expect(row).toHaveTextContent("한국재료연구원");
    expect(row).toHaveTextContent("14일");
    await userEvent.click(within(row).getByText("학술 연구"));
    expect(router.push).toHaveBeenCalledWith(`/commons/access/${id}`);
    // Clicking the default tab clears ?tab= instead of pinning it.
    act(() => setLocation("/commons/access"));
    await userEvent.click(screen.getByRole("tab", { name: "내 요청" }));
    expect(router.replace).toHaveBeenLastCalledWith("/commons/access?tab=requests", { scroll: false });
    await userEvent.click(screen.getByRole("tab", { name: /검토할 요청/ }));
    expect(router.replace).toHaveBeenLastCalledWith("/commons/access", { scroll: false });
  });

  it("my requests: the status filter is a listbox, not a native select", async () => {
    renderScreen(<AccessScreen />, { user: USER.aResearcher, path: "/commons/access" });
    const filter = await screen.findByRole("combobox", { name: "상태" });
    expect(filter.tagName).not.toBe("SELECT");
    expect(await screen.findByText("1건")).toBeInTheDocument();
  });

  it("revoked grants show no expiry countdown or warning colour", async () => {
    getDb().grants.find((g) => g.access_grant_id === GRANT.seed)!.status = "REVOKED";
    renderScreen(<AccessScreen />, { user: USER.aResearcher, path: "/commons/access?tab=grants" });
    expect((await screen.findAllByText("회수됨")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/후 만료|만료됨/, { selector: "span" })).not.toBeInTheDocument();
  });

  it("steward revokes an org grant only after giving a reason", async () => {
    renderScreen(<AccessScreen />, { user: USER.bSteward, path: "/commons/access?tab=org-grants" });
    await userEvent.click((await screen.findAllByRole("button", { name: "회수" }))[0]!);
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "회수" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/^회수 사유/), "과제 종료");
    await userEvent.click(confirm);
    expect(await screen.findByText("권한을 회수했습니다.")).toBeInTheDocument();
    expect(getDb().grants.find((g) => g.access_grant_id === GRANT.seed)).toMatchObject({ status: "REVOKED", revocation_reason: "과제 종료" });
  });

  it("revoke: server field reason is shown localized inside the dialog; a conflict is a localized toast", async () => {
    server.use(http.post("*/mock-api/v1/access-grants/:id/revoke", () => apiError(422, "VALIDATION_FAILED", { fields: [{ field: "reason", reason: "TOO_LONG" }] }), { once: true }));
    renderScreen(<AccessScreen />, { user: USER.bSteward, path: "/commons/access?tab=org-grants" });
    await userEvent.click((await screen.findAllByRole("button", { name: "회수" }))[0]!);
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/^회수 사유/), "사유");
    await userEvent.click(within(dialog).getByRole("button", { name: "회수" }));
    expect(await within(dialog).findByText("너무 깁니다.")).toBeInTheDocument();
    server.use(http.post("*/mock-api/v1/access-grants/:id/revoke", () => apiError(409, "ACCESS_GRANT_NOT_ACTIVE"), { once: true }));
    await userEvent.click(within(dialog).getByRole("button", { name: "회수" }));
    expect(await screen.findByText("이미 만료되었거나 회수된 권한입니다.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("AccessRequestDetailScreen", () => {
  const open = (user: string, id: string) => renderScreen(<AccessRequestDetailScreen accessRequestId={id} />, { user, path: `/commons/access/${id}` });

  it("steward opening a SUBMITTED request starts the review once, then approves with a capped duration", async () => {
    const id = await seedPending(14);
    open(USER.aSteward, id);
    expect((await screen.findAllByText("검토 중")).length).toBeGreaterThan(0);
    expect(request(id).status).toBe("UNDER_REVIEW");
    expect(request(id).history?.filter((h) => h.status === "UNDER_REVIEW")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "승인" }));
    const dialog = screen.getByRole("dialog");
    const days = within(dialog).getByLabelText(/^승인 기간/);
    expect(days).toHaveValue(14);
    expect(days).toHaveAttribute("max", "14");
    await userEvent.clear(days);
    await userEvent.type(days, "15");
    expect(within(dialog).getByRole("button", { name: "승인" })).toBeDisabled();
    await userEvent.clear(days);
    await userEvent.type(days, "7");
    await userEvent.click(within(dialog).getByRole("button", { name: "승인" }));
    expect((await screen.findAllByText("승인됨")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "승인" })).not.toBeInTheDocument();
    const grant = getDb().grants.find((g) => g.access_request_id === id)!;
    expect(Math.round((Date.parse(grant.expires_at) - Date.parse(grant.valid_from)) / 86_400_000)).toBe(7);
  });

  it("the approve cap follows the policy once it has loaded (min of requested and max_grant_days)", async () => {
    const id = await seedPending(30);
    getDb().datasets.find((d) => d.dataset_id === DATASET.sensors)!.policy.max_grant_days = 10;
    open(USER.aSteward, id);
    await userEvent.click(await screen.findByRole("button", { name: "승인" }));
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByLabelText(/^승인 기간/)).toHaveAttribute("max", "10"));
    expect(within(screen.getByRole("dialog")).getByLabelText(/^승인 기간/)).toHaveValue(10);
  });

  it("a SENSITIVE dataset never allows more than 30 grant days even if the policy says more", async () => {
    const sensors = getDb().datasets.find((d) => d.dataset_id === DATASET.sensors)!;
    expect(sensors.access_level).toBe("SENSITIVE");
    sensors.policy.max_grant_days = 90;
    const id = await seedPending(30);
    request(id).requested_days = 60;
    open(USER.aSteward, id);
    await userEvent.click(await screen.findByRole("button", { name: "승인" }));
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByLabelText(/^승인 기간/)).toHaveAttribute("max", "30"));
  });

  it("approve re-check failure from the server is localized and the request stays open", async () => {
    const id = await seedPending();
    server.use(http.post("*/mock-api/v1/access-requests/:id/approve", () => apiError(422, "ACCESS_PURPOSE_NOT_ALLOWED"), { once: true }));
    open(USER.aSteward, id);
    await userEvent.click(await screen.findByRole("button", { name: "승인" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "승인" }));
    expect(await screen.findByText("이 데이터에 허용되지 않은 이용 목적입니다.")).toBeInTheDocument();
    expect(request(id).status).toBe("UNDER_REVIEW");
  });

  it("disables the confirm button while the decision is in flight (no double submit)", async () => {
    const id = await seedPending();
    server.use(http.post("*/mock-api/v1/access-requests/:id/approve", async () => {
      await delay(300);
      return undefined;
    }));
    open(USER.aSteward, id);
    await userEvent.click(await screen.findByRole("button", { name: "승인" }));
    const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: "승인" });
    await userEvent.click(confirm);
    expect(confirm).toBeDisabled();
  });

  it("someone else handled it first → message and refetch", async () => {
    const id = await seedPending();
    open(USER.aSteward, id);
    await screen.findAllByText("검토 중");
    Object.assign(request(id), { status: "WITHDRAWN" });
    await userEvent.click(screen.getByRole("button", { name: "거절" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/^거절 사유/), "목적이 불명확합니다");
    await userEvent.click(within(dialog).getByRole("button", { name: "거절" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("다른 사용자가 먼저 처리했습니다. 최신 상태를 불러옵니다."); // the error toast's announcement
    expect((await screen.findAllByText("철회됨")).length).toBeGreaterThan(0);
  });

  it("approve operations error is tied to the fieldset via aria-describedby", async () => {
    const id = await seedPending();
    server.use(http.post("*/mock-api/v1/access-requests/:id/approve", () => apiError(422, "VALIDATION_FAILED", { fields: [{ field: "operations", reason: "REQUIRED" }] }), { once: true }));
    open(USER.aSteward, id);
    await userEvent.click(await screen.findByRole("button", { name: "승인" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "승인" }));
    const group = await within(dialog).findByRole("group", { name: "권한" });
    const alert = within(dialog).getByRole("alert");
    expect(group.getAttribute("aria-describedby")).toBe(alert.id);
    expect(alert.id).not.toBe("");
  });

  it("reject requires a reason and shows a server field reason inside the dialog", async () => {
    const id = await seedPending();
    server.use(http.post("*/mock-api/v1/access-requests/:id/reject", () => apiError(422, "VALIDATION_FAILED", { fields: [{ field: "reason", reason: "TOO_LONG" }] }), { once: true }));
    open(USER.aSteward, id);
    await userEvent.click(await screen.findByRole("button", { name: "거절" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "거절" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/^거절 사유/), "사유");
    await userEvent.click(within(dialog).getByRole("button", { name: "거절" }));
    expect(await within(dialog).findByText("너무 깁니다.")).toBeInTheDocument();
    expect(request(id).status).toBe("UNDER_REVIEW");
  });

  it("self-approval is not offered, and ACCESS_NOT_REVIEWER from the server is localized", async () => {
    const id = await seedPending();
    const { unmount } = open(USER.bResearcher, id);
    await screen.findByRole("button", { name: "요청 철회" });
    expect(screen.queryByRole("button", { name: "승인" })).not.toBeInTheDocument();
    unmount();
    server.use(http.post("*/mock-api/v1/access-requests/:id/approve", () => apiError(403, "ACCESS_NOT_REVIEWER"), { once: true }));
    open(USER.aSteward, id);
    await userEvent.click(await screen.findByRole("button", { name: "승인" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "승인" }));
    expect(await screen.findByText("이 요청을 검토할 권한이 없습니다.")).toBeInTheDocument();
  });

  it("a steward of another organization gets no reviewer actions", async () => {
    const id = await seedPending();
    open(USER.bSteward, id);
    // B steward is not the owner-org steward; the mock hides the request from them entirely.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "승인" })).not.toBeInTheDocument();
  });

  it("request changes → requester resubmits with the edited text", async () => {
    const id = await seedPending();
    const steward = open(USER.aSteward, id);
    await userEvent.click(await screen.findByRole("button", { name: "수정 요청" }));
    await userEvent.type(within(screen.getByRole("dialog")).getByLabelText(/^수정 요청 내용/), "목적을 더 구체적으로 적어 주세요");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "수정 요청" }));
    expect((await screen.findAllByText("수정 요청됨")).length).toBeGreaterThan(0);
    steward.unmount();

    open(USER.bResearcher, id);
    expect(await screen.findByText("목적을 더 구체적으로 적어 주세요")).toBeInTheDocument();
    const detail = await screen.findByLabelText("목적 상세");
    await userEvent.clear(detail);
    await userEvent.type(detail, "배터리 센서 스트림의 이상 탐지 모델 학습을 위한 상세 설명입니다.");
    await userEvent.click(screen.getByRole("button", { name: "다시 제출" }));
    expect(await screen.findByText("요청을 다시 제출했습니다.")).toBeInTheDocument();
    expect(request(id)).toMatchObject({ status: "SUBMITTED", purpose_detail: "배터리 센서 스트림의 이상 탐지 모델 학습을 위한 상세 설명입니다." });
  });

  it("resubmit maps a server field reason to the field", async () => {
    const id = await seedPending();
    Object.assign(request(id), { status: "CHANGE_REQUESTED" });
    server.use(http.post("*/mock-api/v1/access-requests/:id/resubmit", () => apiError(422, "VALIDATION_FAILED", { fields: [{ field: "purpose_detail", reason: "TOO_SHORT" }] }), { once: true }));
    open(USER.bResearcher, id);
    await userEvent.click(await screen.findByRole("button", { name: "다시 제출" }));
    expect(await screen.findByText("너무 짧습니다.")).toBeInTheDocument();
  });

  it("the resubmit form follows a changed request (updated_at) instead of keeping stale text", async () => {
    const id = await seedPending();
    Object.assign(request(id), { status: "CHANGE_REQUESTED" });
    const { queryClient } = open(USER.bResearcher, id);
    const detail = await screen.findByLabelText("목적 상세");
    await userEvent.type(detail, " 추가");
    act(() => {
      const current = queryClient.getQueryData<Record<string, unknown>>(["getAccessRequest", { accessRequestId: id }])!;
      queryClient.setQueryData(["getAccessRequest", { accessRequestId: id }], { ...current, purpose_detail: "다른 검토자가 반영한 새 상세 설명입니다 충분히 길게.", updated_at: "2099-01-01T00:00:00Z" });
    });
    await waitFor(() => expect(screen.getByLabelText("목적 상세")).toHaveValue("다른 검토자가 반영한 새 상세 설명입니다 충분히 길게."));
  });

  it("reviewer: decisions sit in the right-rail review panel; the history names who acted", async () => {
    const id = await seedPending(14);
    open(USER.aSteward, id);
    const panel = await screen.findByRole("region", { name: "검토" });
    expect(within(panel).getByRole("button", { name: "승인" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "수정 요청" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "거절" })).toBeInTheDocument();
    expect(panel).toHaveTextContent("14일");
    const history = screen.getByRole("region", { name: "진행 이력" });
    expect(await within(history).findByText("최유진")).toBeInTheDocument();
    expect(await within(history).findByText("검토자")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("시험동 공조 설비 센서 스트림");
  });

  it("requester: withdrawing lives in the rail panel, not next to reviewer actions", async () => {
    const id = await seedPending();
    open(USER.bResearcher, id);
    const panel = await screen.findByRole("region", { name: "내 요청" });
    expect(within(panel).getByRole("button", { name: "요청 철회" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "검토" })).not.toBeInTheDocument();
  });

  it("shows a dash for an empty purpose detail", async () => {
    const id = await seedPending();
    request(id).purpose_detail = "";
    open(USER.bResearcher, id);
    const term = await screen.findByText("목적 상세", { selector: "dt" });
    expect(term.nextElementSibling).toHaveTextContent("—");
  });

  it("requester can withdraw (after confirming); reviewer actions are hidden", async () => {
    const id = await seedPending();
    open(USER.bResearcher, id);
    await userEvent.click(await screen.findByRole("button", { name: "요청 철회" }));
    expect(request(id).status).toBe("SUBMITTED");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "요청 철회" }));
    expect((await screen.findAllByText("철회됨")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "승인" })).not.toBeInTheDocument();
  });

  it("approved request shows the grant expiry and a download shortcut", async () => {
    open(USER.aResearcher, REQUEST.seedApproved);
    expect(await screen.findByRole("link", { name: "다운로드" })).toHaveAttribute("href", "/commons/data/00000000-0000-7000-8000-000000002001");
    expect((await screen.findAllByText(/후 만료/)).length).toBeGreaterThan(0);
  });

  it("an approved request whose grant was revoked offers no download", async () => {
    getDb().grants.find((g) => g.access_grant_id === GRANT.seed)!.status = "REVOKED";
    open(USER.aResearcher, REQUEST.seedApproved);
    expect((await screen.findAllByText("회수됨")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "다운로드" })).not.toBeInTheDocument();
  });

  it("renders user-entered text as plain text (no HTML injection)", async () => {
    const id = await seedPending();
    request(id).purpose_detail = '<img src=x onerror="alert(1)"> **굵게**';
    const { container } = open(USER.bResearcher, id);
    expect(await screen.findByText('<img src=x onerror="alert(1)"> **굵게**')).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });
});
