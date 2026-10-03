import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/mocks/db";
import { GRANT, INPUT, OUTPUT, PROJECT, RECIPE, THREAD, USER } from "@/mocks/fixtures";
import { server } from "../../../tests/msw";
import { router, setLocation } from "../../../tests/navigation";
import { renderScreen } from "../../../tests/render";
import { renderWorkspace } from "../../../tests/workspace-routes";
import { AccessScreen } from "../governance/access-screen";
import { accessFloor } from "./upload-output-dialog";
import { parseFor, parseScalar, stepProblem } from "./recipe-steps";

// jsdom's XMLHttpRequest sends a File as text, so the presigned PUT goes through fetch with the file's bytes here
// (the browser path — XHR with upload progress — is covered by the upload feature's transfer tests).
vi.mock("@/features/upload/lib/transfer", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/upload/lib/transfer")>();
  const bytes = (blob: Blob) =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
  return {
    ...real,
    putWithProgress: async (url: string, body: Blob, headers: Record<string, string> = {}, onProgress?: (n: number) => void) => {
      const res = await fetch(url, { method: "PUT", body: await bytes(body), headers });
      if (!res.ok) throw new real.HttpError(res.status);
      onProgress?.(body.size);
      return { etag: res.headers.get("ETag") };
    },
  };
});

const base = `/commons/projects/${PROJECT.seed}`;
const revokeBatteryGrant = () => {
  getDb().grants.find((g) => g.access_grant_id === GRANT.seed)!.status = "REVOKED";
};

describe("workspace frame", () => {
  it("overview shows inputs, recent runs and outputs with links into the tabs", async () => {
    renderWorkspace(base, USER.aResearcher);
    const inputs = await screen.findByRole("region", { name: "입력 데이터" });
    expect(await within(inputs).findByRole("link", { name: "리튬이온 배터리 셀 사이클 시험 데이터" })).toHaveAttribute("href", expect.stringMatching(/\/commons\/data\//));
    const runs = screen.getAllByRole("region", { name: "최근 실행" })[0]!;
    expect((await within(runs).findAllByRole("link", { name: "산출물 보기" }))[0]).toHaveAttribute("href", `${base}/outputs/${OUTPUT.capacity}`);
    expect(within(screen.getAllByRole("region", { name: "최근 산출물" })[0]!).getByRole("link", { name: /용량 유지율 추이/ })).toBeInTheDocument();
  });
});

describe("데이터 tab", () => {
  it("adds a dataset as an input through the search dialog", async () => {
    renderWorkspace(`${base}/data`, USER.aResearcher);
    await userEvent.click(await screen.findByRole("button", { name: "데이터 추가" }));
    const dialog = await screen.findByRole("dialog", { name: "데이터 추가" });
    // Datasets already used are listed but not selectable.
    expect(await within(dialog).findByRole("radio", { name: /리튬이온 배터리 셀 사이클 시험 데이터/ })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(dialog).getByRole("radio", { name: /시험동 공조 설비 센서 스트림/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "입력으로 추가" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "데이터 추가" })).not.toBeInTheDocument());
    const table = screen.getByRole("table", { name: "입력 데이터" });
    expect(await within(table).findByRole("link", { name: "시험동 공조 설비 센서 스트림" })).toBeInTheDocument();
  });

  it("ACCESS_REQUIRED hands over to the access request", async () => {
    renderWorkspace(`${base}/data`, USER.bResearcher);
    await userEvent.click(await screen.findByRole("button", { name: "데이터 추가" }));
    const dialog = await screen.findByRole("dialog", { name: "데이터 추가" });
    await userEvent.click(await within(dialog).findByRole("radio", { name: /시험동 공조 설비 센서 스트림/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "입력으로 추가" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("이 데이터를 쓰려면 접근 권한이 필요합니다");
    await userEvent.click(within(alert).getByRole("button", { name: "접근 요청" }));
    expect(await screen.findByRole("dialog", { name: "접근 요청" })).toHaveTextContent("시험동 공조 설비 센서 스트림");
  });

  it("an input whose access lapsed is marked with an access request, and the overview warns", async () => {
    revokeBatteryGrant();
    renderWorkspace(`${base}/data`, USER.aResearcher);
    const table = await screen.findByRole("table", { name: "입력 데이터" });
    const row = (await within(table).findByRole("link", { name: "리튬이온 배터리 셀 사이클 시험 데이터" })).closest("tr")!;
    expect(within(row).getByText("접근 권한 없음")).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "접근 요청" }));
    expect(await screen.findByRole("dialog", { name: "접근 요청" })).toBeInTheDocument();
  });

  it("VIEWER sees the inputs without changing them", async () => {
    getDb().projectMembers.find((m) => m.user_id === USER.bResearcher && m.project_id === PROJECT.seed)!.role = "VIEWER";
    renderWorkspace(`${base}/data`, USER.bResearcher);
    await screen.findByRole("table", { name: "입력 데이터" });
    expect(screen.queryByRole("button", { name: "데이터 추가" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /빼기$/ })).not.toBeInTheDocument();
  });
});

describe("변환 (recipes)", () => {
  const editor = `${base}/recipes/${RECIPE.capacity}`;

  it("lists recipes and every run", async () => {
    renderWorkspace(`${base}/recipes`, USER.aResearcher);
    const table = await screen.findByRole("table", { name: "변환 레시피" });
    expect(within(table).getByRole("link", { name: "용량 유지율 추이 (사이클 1~300)" })).toHaveAttribute("href", editor);
    expect(await screen.findByRole("table", { name: "실행 기록" })).toHaveTextContent("성공");
  });

  it("a failed run shows the Korean sentence for its error code, never the raw code", async () => {
    const run = getDb().runs.find((r) => r.project_id === PROJECT.seed)!;
    Object.assign(run, { status: "FAILED", error: "INPUT_TOO_LARGE", output_id: null });
    const { unmount } = renderWorkspace(`${base}/recipes`, USER.aResearcher);
    const table = await screen.findByRole("table", { name: "실행 기록" });
    expect(await within(table).findByText("입력 데이터가 허용 크기를 넘었습니다.")).toBeInTheDocument();
    expect(table).not.toHaveTextContent("INPUT_TOO_LARGE");
    unmount();
    run.error = "SOMETHING_NEW: English detail";
    renderWorkspace(`${base}/recipes`, USER.aResearcher);
    const again = await screen.findByRole("table", { name: "실행 기록" });
    expect(await within(again).findByText("실행에 실패했습니다.")).toBeInTheDocument();
    expect(again).not.toHaveTextContent("English");
  });

  it("adds a step; a missing parameter and the server's RECIPE_INVALID are shown at the step", async () => {
    renderWorkspace(editor, USER.aResearcher);
    const steps = await screen.findByRole("region", { name: "변환 단계" });
    const items = () => [...steps.querySelectorAll<HTMLElement>(":scope ol > li")];
    expect(items()).toHaveLength(4);
    await userEvent.selectOptions(screen.getByLabelText("단계 종류"), "filter_rows");
    await userEvent.click(screen.getByRole("button", { name: "단계 추가" }));
    const step5 = items()[4]!;
    expect(within(step5).getByRole("heading", { name: /행 필터/ })).toBeInTheDocument();
    expect(screen.getByText("저장하지 않은 변경")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "미리보기" }));
    expect(await within(step5).findByRole("alert")).toHaveTextContent("열 이름을 입력하세요.");

    await userEvent.type(within(step5).getByLabelText("열"), "no_such_column");
    await userEvent.type(within(step5).getByLabelText("값"), "1");
    await userEvent.click(screen.getByRole("button", { name: "미리보기" }));
    expect(await within(step5).findByRole("alert")).toHaveTextContent("‘no_such_column’ 열이 이 단계 앞의 데이터에 없습니다.");
  });

  it("previews unsaved steps as a bounded table", async () => {
    renderWorkspace(editor, USER.aResearcher);
    await screen.findByRole("region", { name: "변환 단계" });
    await userEvent.click(screen.getByRole("button", { name: "미리보기" }));
    const table = await screen.findByRole("table", { name: "미리보기 결과" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["cycle", "capacity_ah", "temp_c"]);
    expect(screen.getByText(/결과 300행 · 처음 100행 표시/)).toBeInTheDocument();
  });

  it("saving over a newer version is a conflict that offers the latest version", async () => {
    renderWorkspace(editor, USER.aResearcher);
    const name = await screen.findByLabelText("레시피 이름");
    // Someone else saves v2 meanwhile.
    const stored = getDb().recipes.find((r) => r.recipe_id === RECIPE.capacity)!;
    stored.version = 2;
    stored.name = "용량 유지율 (동료 수정)";
    stored.history.push({ version: 2, name: stored.name, input_ids: stored.input_ids, steps: stored.steps });
    await userEvent.clear(name);
    await userEvent.type(name, "용량 유지율 (내 수정)");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    const alert = await screen.findByText(/다른 구성원이 이 레시피를 먼저 저장했습니다 \(현재 v2\)/);
    await userEvent.click(within(alert.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "최신 버전 불러오기" }));
    // The draft on screen would be lost: confirm first.
    const confirm = await screen.findByRole("dialog", { name: "저장하지 않은 변경이 있습니다" });
    await userEvent.click(within(confirm).getByRole("button", { name: "계속" }));
    await waitFor(() => expect(screen.getByLabelText("레시피 이름")).toHaveValue("용량 유지율 (동료 수정)"));
    expect(screen.getByRole("heading", { level: 2, name: "용량 유지율 (동료 수정)" })).toBeInTheDocument();
  });

  it("saves a new version, runs it, polls until it succeeds and links the output", async () => {
    renderWorkspace(editor, USER.aResearcher);
    const name = await screen.findByLabelText("레시피 이름");
    await userEvent.type(name, " 개정");
    expect(screen.getByRole("button", { name: "실행" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByText("레시피를 저장했습니다 (v2).")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "실행" }));
    const runs = screen.getByRole("table", { name: "실행 기록" });
    const first = () => within(runs).getAllByRole("row")[1]!;
    await waitFor(() => expect(first()).toHaveTextContent("v2"));
    await waitFor(() => expect(within(first()).getByRole("link", { name: "산출물 보기" })).toBeInTheDocument(), { timeout: 8000 });
    expect(first()).toHaveTextContent("성공");
    const outputId = getDb().runs.find((r) => r.recipe_version === 2)!.output_id;
    expect(within(first()).getByRole("link", { name: "산출물 보기" })).toHaveAttribute("href", `${base}/outputs/${outputId}`);
  }, 15_000);

  it("a lapsed input blocks the run with a reason", async () => {
    revokeBatteryGrant();
    renderWorkspace(editor, USER.aResearcher);
    await screen.findByRole("region", { name: "변환 단계" });
    expect(await screen.findByText(/접근 권한이 끝난 입력: 리튬이온 배터리 셀 사이클 시험 데이터/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "실행" })).toBeDisabled();
    expect(screen.getByText("접근 권한이 끝난 입력이 있어 실행할 수 없습니다.")).toBeInTheDocument();
  });
});

describe("산출물 (outputs)", () => {
  const detail = `${base}/outputs/${OUTPUT.capacity}`;

  it("output detail: lineage as a picture and a list, files, and its discussion", async () => {
    renderWorkspace(detail, USER.aResearcher);
    const lineage = await screen.findByRole("region", { name: "데이터 계보" });
    const img = within(lineage).getByRole("img", { name: /데이터 계보/ });
    expect(img).toHaveAccessibleName(expect.stringContaining("리튬이온 배터리 셀 사이클 시험 데이터 v1.1"));
    expect(within(lineage).getByRole("link", { name: "리튬이온 배터리 셀 사이클 시험 데이터" })).toBeInTheDocument();
    expect(within(lineage).getByRole("link", { name: "용량 유지율 추이 (사이클 1~300)" })).toHaveAttribute("href", `${base}/recipes/${RECIPE.capacity}`);
    expect(screen.getByRole("table", { name: "파일" })).toHaveTextContent("result.parquet");
    expect(screen.getByRole("region", { name: "이 산출물 토론" })).toBeInTheDocument();
  });

  it("download is disabled with a reason once access to a lineage input lapsed", async () => {
    revokeBatteryGrant();
    renderWorkspace(detail, USER.aResearcher);
    await waitFor(() => expect(screen.getByRole("button", { name: "내려받기" })).toBeDisabled());
    expect(screen.getByText("접근 권한이 끝난 입력 데이터에서 만든 산출물이라 내려받을 수 없습니다: 리튬이온 배터리 셀 사이클 시험 데이터")).toBeInTheDocument();
  });

  it("download still reports the server's INPUT_ACCESS_LAPSED", async () => {
    server.use(
      http.post("*/mock-api/v1/projects/:project_id/outputs/:output_id/download", () =>
        HttpResponse.json({ error: { code: "INPUT_ACCESS_LAPSED", message: "x", trace_id: "t" } }, { status: 409 }),
      ),
    );
    renderWorkspace(detail, USER.aResearcher);
    const button = await screen.findByRole("button", { name: "내려받기" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByText("입력 데이터의 접근 권한이 회수되었거나 만료되어 실행하거나 내려받을 수 없습니다.")).toBeInTheDocument();
  });

  it("upload: levels looser than the strictest input can't be chosen; the server's floor shows at the field", async () => {
    expect(accessFloor([])).toBe("INTERNAL");
    expect(accessFloor(["PUBLIC", "CONTROLLED", "INTERNAL"])).toBe("CONTROLLED");
    renderWorkspace(`${base}/outputs`, USER.aResearcher);
    const open = await screen.findByRole("button", { name: "파일 올리기" });
    await waitFor(() => expect(open).toBeEnabled());
    await userEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "파일 올리기" });
    expect(within(dialog).getByRole("radio", { name: "공개" })).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByRole("radio", { name: "기관 내부" })).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByRole("radio", { name: "통제" })).toBeChecked();
    expect(within(dialog).getByText(/가장 엄격한 등급: 통제/)).toBeInTheDocument();

    // The server re-checks (e.g. an input added meanwhile raised the floor).
    server.use(
      http.post("*/mock-api/v1/projects/:project_id/outputs", () =>
        HttpResponse.json({ error: { code: "VALIDATION_FAILED", message: "x", trace_id: "t", details: { field: "access_level", minimum: "SENSITIVE" } } }, { status: 422 }),
      ),
    );
    await userEvent.type(within(dialog).getByLabelText("산출물 이름"), "분석 보고서");
    await userEvent.upload(within(dialog).getByLabelText("파일"), new File(["report"], "report.txt", { type: "text/plain" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "올리기" }));
    expect(await within(dialog).findByText("접근 등급은 입력 데이터 중 가장 엄격한 등급(민감) 아래로 낮출 수 없습니다.")).toBeInTheDocument();
  });

  it("upload: hashes, PUTs and completes a file output, then opens it", async () => {
    renderWorkspace(`${base}/outputs`, USER.aResearcher);
    const open = await screen.findByRole("button", { name: "파일 올리기" });
    await waitFor(() => expect(open).toBeEnabled());
    await userEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "파일 올리기" });
    await userEvent.type(within(dialog).getByLabelText("산출물 이름"), "분석 보고서 초안");
    await userEvent.upload(within(dialog).getByLabelText("파일"), new File(["# 분석 보고서\n"], "report.md", { type: "text/markdown" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "올리기" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^${base}/outputs/[0-9a-f-]{36}$`))), { timeout: 8000 });
    const stored = getDb().outputs.find((o) => o.title === "분석 보고서 초안")!;
    expect(stored.status).toBe("READY");
    expect(stored.access_level).toBe("CONTROLLED");
  }, 15_000);

  it("a file name the storage can't take is flagged before upload", async () => {
    renderWorkspace(`${base}/outputs`, USER.aResearcher);
    const open = await screen.findByRole("button", { name: "파일 올리기" });
    await waitFor(() => expect(open).toBeEnabled());
    await userEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "파일 올리기" });
    await userEvent.type(within(dialog).getByLabelText("산출물 이름"), "보고서");
    await userEvent.upload(within(dialog).getByLabelText("파일"), new File(["x"], "보고서 최종.pdf", { type: "application/pdf" }));
    expect(within(dialog).getByText("파일 이름을 바꿔 주세요: 보고서 최종.pdf")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "올리기" })).toBeDisabled();
  });
});

describe("허브 공개 (publish request and review)", () => {
  const detail = `${base}/outputs/${OUTPUT.capacity}`;

  it("request → approval slots per organization; the steward's review records a decision; rejection needs a reason", async () => {
    renderWorkspace(detail, USER.aResearcher);
    await userEvent.click(await screen.findByRole("button", { name: "허브 공개 요청" }));
    const dialog = await screen.findByRole("dialog", { name: "허브 공개 요청" });
    expect(within(dialog).getByLabelText("데이터셋 제목")).toHaveValue("용량 유지율 추이 (사이클 1~300) (v1)");
    await userEvent.click(within(dialog).getByRole("button", { name: "요청 보내기" }));
    const approvals = await screen.findByRole("region", { name: "기관별 승인" });
    const orgs = within(approvals).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0]!.textContent);
    expect(orgs).toEqual(["한국재료연구원", "한국에너지기술연구원"]);
    expect(approvals).toHaveTextContent("결정 대기");
    expect(screen.queryByRole("button", { name: "허브 공개 요청" })).not.toBeInTheDocument();
  });

  it("access screen 공개 요청 tab: reject needs a comment; approve records the slot", async () => {
    const out = getDb().outputs.find((o) => o.output_id === OUTPUT.capacity)!;
    out.publish_status = "PENDING";
    getDb().publishRequests.push({
      request_id: "00000000-0000-7000-8000-00000000f901",
      output_id: OUTPUT.capacity,
      project_id: PROJECT.seed,
      status: "PENDING",
      approvals: [
        { organization_id: "00000000-0000-7000-8000-00000000000b", kind: "INPUT_OWNER", decided_by: null, decision: null, comment: null, decided_at: null },
        { organization_id: "00000000-0000-7000-8000-00000000000a", kind: "LEAD_ORGANIZATION", decided_by: null, decision: null, comment: null, decided_at: null },
      ],
      created_by: USER.aResearcher,
      created_at: new Date().toISOString(),
      published_dataset_id: null,
      failure_reason: null,
      title: out.title,
      description: "",
      lead_organization_id: "00000000-0000-7000-8000-00000000000a",
      approved_by: null,
    });
    renderScreen(<AccessScreen />, { user: USER.bSteward, path: "/commons/access?tab=publish" });
    expect(await screen.findByRole("tab", { name: "공개 요청 (1건 결정 대기)" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(await screen.findByRole("button", { name: /검토$/ }));
    const dialog = await screen.findByRole("dialog", { name: "허브 공개 검토" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "반려" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "결정 기록" }));
    expect(within(dialog).getByText("반려 사유를 입력하세요.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("radio", { name: "승인" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "결정 기록" }));
    expect(await screen.findByText("결정을 기록했습니다. 다른 기관의 결정을 기다립니다.")).toBeInTheDocument();
    expect(getDb().publishRequests.at(-1)!.approvals[0]!.decision).toBe("APPROVE");
  });

  it("a steward never decides their own request", async () => {
    getDb().projectMembers.push({ ...getDb().projectMembers.find((m) => m.user_id === USER.bResearcher)!, user_id: USER.bSteward });
    getDb().publishRequests.push({
      request_id: "00000000-0000-7000-8000-00000000f902",
      output_id: OUTPUT.capacity,
      project_id: PROJECT.seed,
      status: "PENDING",
      approvals: [{ organization_id: "00000000-0000-7000-8000-00000000000b", kind: "INPUT_OWNER", decided_by: null, decision: null, comment: null, decided_at: null }],
      created_by: USER.bSteward,
      created_at: new Date().toISOString(),
      published_dataset_id: null,
      failure_reason: null,
      title: "자기 요청",
      description: "",
      lead_organization_id: "00000000-0000-7000-8000-00000000000a",
      approved_by: null,
    });
    renderScreen(<AccessScreen />, { user: USER.bSteward, path: "/commons/access?tab=publish" });
    expect(await screen.findByText("본인이 요청한 공개는 결정할 수 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /검토$/ })).not.toBeInTheDocument();
  });

  it("a failed publication shows the system's reason and can be requested again", async () => {
    const out = getDb().outputs.find((o) => o.output_id === OUTPUT.capacity)!;
    out.publish_status = "REJECTED";
    getDb().publishRequests.push({
      request_id: "00000000-0000-7000-8000-00000000f903",
      output_id: OUTPUT.capacity,
      project_id: PROJECT.seed,
      status: "REJECTED",
      approvals: [{ organization_id: "00000000-0000-7000-8000-00000000000b", kind: "INPUT_OWNER", decided_by: USER.bSteward, decision: "APPROVE", comment: null, decided_at: new Date().toISOString() }],
      created_by: USER.aResearcher,
      created_at: new Date().toISOString(),
      published_dataset_id: null,
      failure_reason: "카탈로그 파일 검증에 실패했습니다. 산출물 파일을 확인한 뒤 다시 요청하세요.",
      title: out.title,
      description: "",
      lead_organization_id: "00000000-0000-7000-8000-00000000000a",
      approved_by: USER.bSteward,
    });
    renderWorkspace(detail, USER.aResearcher);
    expect(await screen.findByText(/공개하지 못했습니다: 카탈로그 파일 검증에 실패했습니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 요청" })).toBeInTheDocument();
  });
});

describe("토론 tab", () => {
  it("lists the project's threads with what they are about and opens one", async () => {
    renderWorkspace(`${base}/discussion`, USER.aResearcher);
    const thread = await screen.findByRole("button", { name: /배터리 입력을 v2.0으로 올릴지 논의/ });
    expect(thread).toHaveTextContent("프로젝트");
    await userEvent.click(thread);
    expect(router.replace).toHaveBeenCalledWith(`${base}/discussion?thread=${THREAD.project}`, { scroll: false });
    expect(await screen.findByRole("heading", { name: "배터리 입력을 v2.0으로 올릴지 논의" })).toBeInTheDocument();
    expect(await screen.findByText(/레시피 검증이 끝나면 다음 주에 v2.0으로 바꾸겠습니다/)).toBeInTheDocument();
  });

  it("starts a project thread", async () => {
    renderWorkspace(`${base}/discussion`, USER.aResearcher);
    await userEvent.click(await screen.findByRole("button", { name: "새 토론" }));
    const form = screen.getByRole("form", { name: "새 토론" });
    await userEvent.type(within(form).getByLabelText("제목"), "산출물 공개 범위");
    await userEvent.type(within(form).getByLabelText(/^내용/), "허브 공개 전에 범위를 정합시다.");
    await userEvent.click(within(form).getByRole("button", { name: "토론 시작" }));
    expect(await screen.findByRole("heading", { name: "산출물 공개 범위" })).toBeInTheDocument();
    act(() => setLocation(`${base}/discussion`));
    expect(await screen.findByRole("button", { name: /산출물 공개 범위/ })).toBeInTheDocument();
  });
});

describe("recipe step helpers", () => {
  it("parses typed values the way the step needs them", () => {
    expect(parseScalar("300")).toBe(300);
    expect(parseScalar("2.5")).toBe(2.5);
    expect(parseScalar("true")).toBe(true);
    expect(parseScalar('"300"')).toBe("300");
    expect(parseScalar("C-01")).toBe("C-01");
  });

  it("flags missing parameters per step type", () => {
    expect(stepProblem({ type: "select_columns", columns: [] }, [INPUT.battery])).toBe("columns");
    expect(stepProblem({ type: "filter_rows", column: "cycle", op: "is_null" }, [INPUT.battery])).toBeNull();
    expect(stepProblem({ type: "join", right_input_id: INPUT.battery, on: ["cycle"], how: "left" }, [INPUT.battery])).toBe("right");
    expect(stepProblem({ type: "join", right_input_id: INPUT.openMaterials, on: [], how: "left" }, [INPUT.battery, INPUT.openMaterials])).toBe("on");
    expect(stepProblem({ type: "limit", n: 0 }, [INPUT.battery])).toBe("n");
  });
});

describe("review fixes (Task 14 round 1)", () => {
  const editor = `${base}/recipes/${RECIPE.capacity}`;
  const makeDirty = async () => {
    const name = await screen.findByLabelText("레시피 이름");
    await userEvent.type(name, " 개정");
    expect(screen.getByText("저장하지 않은 변경")).toBeInTheDocument();
  };

  it("leaving the editor with unsaved changes asks first (tab link, header edit, page unload)", async () => {
    renderWorkspace(editor, USER.aResearcher);
    await makeDirty();
    const tabs = screen.getByRole("navigation", { name: "프로젝트 작업 공간" });
    await userEvent.click(within(tabs).getByRole("link", { name: "산출물" }));
    let dialog = await screen.findByRole("dialog", { name: "저장하지 않은 변경이 있습니다" });
    await userEvent.click(within(dialog).getByRole("button", { name: "머무르기" }));
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByLabelText("레시피 이름")).toHaveValue("용량 유지율 추이 (사이클 1~300) 개정");

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "편집" }));
    dialog = await screen.findByRole("dialog", { name: "저장하지 않은 변경이 있습니다" });
    await userEvent.click(within(dialog).getByRole("button", { name: "머무르기" }));
    expect(router.push).not.toHaveBeenCalled();

    await userEvent.click(within(tabs).getByRole("link", { name: "산출물" }));
    dialog = await screen.findByRole("dialog", { name: "저장하지 않은 변경이 있습니다" });
    await userEvent.click(within(dialog).getByRole("button", { name: "계속" }));
    expect(router.push).toHaveBeenCalledWith(`${base}/outputs`);
  });

  it("a clean editor navigates and unloads without asking", async () => {
    renderWorkspace(editor, USER.aResearcher);
    await screen.findByLabelText("레시피 이름");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });

  it("column suggestions come from each input's column profile, not from a preview", async () => {
    let previews = 0;
    server.events.on("request:start", ({ request }) => {
      if (request.url.endsWith("/preview") && request.method === "POST") previews += 1;
    });
    const { container } = renderWorkspace(editor, USER.aResearcher);
    await screen.findByRole("region", { name: "변환 단계" });
    await waitFor(() => expect([...container.querySelectorAll("datalist option")].map((o) => o.getAttribute("value"))).toEqual(expect.arrayContaining(["cycle", "voltage_v", "temp_c"])));
    // Joining a second input adds its columns too.
    await userEvent.click(screen.getByLabelText(/구조용 세라믹·초내열합금 물성 DB/));
    await waitFor(() => expect(container.querySelectorAll("datalist option").length).toBeGreaterThan(4));
    expect(previews).toBe(0);
    server.events.removeAllListeners();
  });

  it("filter values follow the column's type; quotes force text", () => {
    expect(parseFor("string")("300")).toBe("300");
    expect(parseFor("date")("2026-01-01")).toBe("2026-01-01");
    expect(parseFor("integer")("300")).toBe(300);
    expect(parseFor("number")("2.5")).toBe(2.5);
    expect(parseFor("boolean")("true")).toBe(true);
    expect(parseFor("integer")('"300"')).toBe("300");
    expect(parseFor(undefined)("300")).toBe(300);
  });

  it("a TYPE_MISMATCH on a column of unknown type suggests quoting", async () => {
    server.use(
      http.post("*/mock-api/v1/projects/:project_id/recipes/:recipe_id/preview", () =>
        HttpResponse.json({ error: { code: "RECIPE_INVALID", message: "x", trace_id: "t", details: { step_index: 1, reason: "TYPE_MISMATCH", column: "batch_code" } } }, { status: 422 }),
      ),
    );
    renderWorkspace(editor, USER.aResearcher);
    const steps = await screen.findByRole("region", { name: "변환 단계" });
    await userEvent.click(screen.getByRole("button", { name: "미리보기" }));
    const step2 = [...steps.querySelectorAll<HTMLElement>(":scope ol > li")][1]!;
    expect(await within(step2).findByRole("alert")).toHaveTextContent("텍스트로 비교하려면 큰따옴표로 감싸세요");
  });

  it("VIEWER: the recipe editor, outputs and output detail are read-only", async () => {
    getDb().projectMembers.find((m) => m.user_id === USER.bResearcher && m.project_id === PROJECT.seed)!.role = "VIEWER";
    const view = renderWorkspace(editor, USER.bResearcher);
    expect(await screen.findByLabelText("레시피 이름")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "저장" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "실행" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "단계 추가" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "미리보기" })).toBeInTheDocument();
    view.unmount();

    const outputs = renderWorkspace(`${base}/outputs`, USER.bResearcher);
    await screen.findByRole("table", { name: "산출물" });
    expect(screen.queryByRole("button", { name: "파일 올리기" })).not.toBeInTheDocument();
    outputs.unmount();

    renderWorkspace(`${base}/outputs/${OUTPUT.capacity}`, USER.bResearcher);
    await screen.findByRole("region", { name: "데이터 계보" });
    expect(screen.queryByRole("button", { name: "허브 공개 요청" })).not.toBeInTheDocument();
  });

  it("run polling stops once no run is queued or running", async () => {
    let polls = 0;
    server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname.endsWith("/runs") && request.method === "GET") polls += 1;
    });
    renderWorkspace(editor, USER.aResearcher);
    await userEvent.click(await screen.findByRole("button", { name: "실행" }));
    const runs = screen.getByRole("table", { name: "실행 기록" });
    await waitFor(() => expect(within(within(runs).getAllByRole("row")[1]!).getByRole("link", { name: "산출물 보기" })).toBeInTheDocument(), { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 300));
    const settled = polls;
    await new Promise((r) => setTimeout(r, 2600));
    expect(polls).toBe(settled);
    server.events.removeAllListeners();
  }, 15_000);

  it("upload fails clearly when the session has no upload target for a file", async () => {
    server.use(
      http.post("*/mock-api/v1/projects/:project_id/outputs", () =>
        HttpResponse.json({ output_id: OUTPUT.capacity, expires_at: new Date(Date.now() + 60_000).toISOString(), files: [] }, { status: 201 }),
      ),
    );
    renderWorkspace(`${base}/outputs`, USER.aResearcher);
    const open = await screen.findByRole("button", { name: "파일 올리기" });
    await waitFor(() => expect(open).toBeEnabled());
    await userEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "파일 올리기" });
    await userEvent.type(within(dialog).getByLabelText("산출물 이름"), "보고서");
    await userEvent.upload(within(dialog).getByLabelText("파일"), new File(["x"], "report.txt", { type: "text/plain" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "올리기" }));
    expect(await within(dialog).findByText("업로드 세션에 report.txt 파일의 업로드 주소가 없습니다. 다시 올려 주세요.")).toBeInTheDocument();
  });
});
