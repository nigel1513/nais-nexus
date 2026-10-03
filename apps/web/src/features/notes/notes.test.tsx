import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { usePathname } from "next/navigation";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/mocks/db";
import { NOTE, PROJECT, USER } from "@/mocks/fixtures";
import { contentHash, seoulDate } from "@/mocks/note-hash";
import { seedNotebookActivity } from "@/mocks/notebook-activity";
import { MOCK_AUTH_TIME_COOKIE } from "@/shared/config";
import { server } from "../../../tests/msw";
import { router } from "../../../tests/navigation";
import { renderScreen } from "../../../tests/render";
import { renderWorkspace } from "../../../tests/workspace-routes";
import { NoteScreen } from "./note-screen";
import { NotesScreen } from "./notes-screen";

/** /commons/notes and /commons/notes/{id} picked from the mocked pathname, like the app router. */
function NoteRoutes() {
  const pathname = usePathname();
  const id = pathname.split("/")[3];
  return id ? <NoteScreen key={id} noteId={id} /> : <NotesScreen />;
}
const renderNotes = (path: string, user: string) => renderScreen(<NoteRoutes />, { user, path });

const draftNote = () => getDb().notes.find((n) => n.note_id === NOTE.draft)!;
const signedNote = () => getDb().notes.find((n) => n.note_id === NOTE.signed)!;
const requireWitness = (witness = USER.bResearcher) => {
  getDb().noteSettings[PROJECT.seed] = { witness_required: true, witness_user_ids: [witness] };
};
/** Today's draft submitted with 최유진 as the witness (the state submitNote leaves). */
const submitDraftForWitness = () => {
  const n = draftNote();
  Object.assign(n, { status: "SUBMITTED", witness_required: true, witness_user_ids: [USER.bResearcher], submitted_at: new Date().toISOString() });
  n.content_hash = contentHash(n);
};
const seedNotebook = () =>
  seedNotebookActivity({
    user_id: USER.aResearcher,
    project_id: PROJECT.seed,
    day: seoulDate(),
    title: "temp_c 주기 분석",
    saved_at: new Date().toISOString(),
    cells: [
      { type: "markdown", source_head: "# temp_c 9 사이클 주기 확인", output_kinds: [], output_count: 0, has_error: false },
      { type: "code", source_head: "df.groupby('cell_id').temp_c.mean()", output_kinds: ["table"], output_count: 1, has_error: false },
    ],
  });
const errorBody = (code: string, details: Record<string, unknown> = {}) => ({ error: { code, message: code, trace_id: "t", details } });

describe("연구노트 목록·검색", () => {
  it("내 노트 lists my notes newest first; 확인할 노트 lists the notes waiting for me", async () => {
    renderNotes("/commons/notes", USER.aResearcher);
    expect(await screen.findByRole("heading", { level: 1, name: "연구노트" })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "내 노트" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(seoulDate());
    expect(rows[0]).toHaveTextContent("작성 중");
    expect(rows[1]).toHaveTextContent("서명 완료");
    expect(within(rows[0]!).getByRole("link", { name: new RegExp(seoulDate()) })).toHaveAttribute("href", `/commons/notes/${NOTE.draft}`);
  });

  it("확인할 노트: a witness sees the submitted note of another recorder", async () => {
    submitDraftForWitness();
    renderNotes("/commons/notes?tab=witness", USER.bResearcher);
    const table = await screen.findByRole("table", { name: "확인할 노트" });
    const row = within(table).getAllByRole("row")[1]!;
    expect(row).toHaveTextContent("김민준");
    expect(row).toHaveTextContent("제출됨");
  });

  it("search lists snippets best first linking to the note and never shows the score", async () => {
    server.use(
      http.get("*/mock-api/v1/notes/search", () =>
        HttpResponse.json({
          items: [
            { note_id: NOTE.signed, project_name: "차세대 이차전지 소재 공동연구", note_date: "2026-09-30", snippet: "용량 감소율 정량화", score: 0.41 },
            { note_id: NOTE.draft, project_name: "차세대 이차전지 소재 공동연구", note_date: "2026-10-03", snippet: "temp_c 상승 구간 판별", score: 0.93 },
          ],
        }),
      ),
    );
    renderNotes("/commons/notes", USER.aResearcher);
    await userEvent.type(await screen.findByRole("searchbox", { name: "연구노트 검색" }), "온도 주기");
    await userEvent.click(screen.getByRole("button", { name: "검색" }));
    const results = await screen.findByRole("region", { name: "검색 결과" });
    const links = await within(results).findAllByRole("link");
    expect(links[0]).toHaveAttribute("href", `/commons/notes/${NOTE.draft}`);
    expect(links[1]).toHaveAttribute("href", `/commons/notes/${NOTE.signed}`);
    expect(results).toHaveTextContent("temp_c 상승 구간 판별");
    expect(results.textContent).not.toMatch(/0\.93|0\.41|93|41/);
  });

  it("keyword search through the mock finds the signed note", async () => {
    renderNotes("/commons/notes?q=18650", USER.aResearcher);
    const results = await screen.findByRole("region", { name: "검색 결과" });
    expect(await within(results).findByRole("link", { name: /차세대 이차전지 소재 공동연구/ })).toHaveAttribute("href", `/commons/notes/${NOTE.signed}`);
  });
});

describe("표준 양식 편집기", () => {
  it("reads like the standard form: header, seven sections in order, signature block", async () => {
    renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    const header = await screen.findByRole("table", { name: "노트 정보" });
    expect(within(header).getByRole("rowheader", { name: "과제명" }).nextElementSibling).toHaveTextContent("차세대 이차전지 소재 공동연구");
    expect(within(header).getByRole("rowheader", { name: "연구일자" }).nextElementSibling).toHaveTextContent(seoulDate());
    expect(within(header).getByRole("rowheader", { name: "기록자" }).nextElementSibling).toHaveTextContent("김민준");
    expect(await within(header).findByText("한국에너지기술연구원")).toBeInTheDocument();
    const sections = screen.getAllByRole("group").filter((g) => g.hasAttribute("data-section")).map((g) => g.getAttribute("aria-label") ?? within(g).getAllByText(/./)[0]!.textContent);
    expect(sections).toEqual(["연구 목표", "연구 방법·재료", "수행 내용", "결과 및 관찰", "고찰·문제점", "향후 계획", "참고 자료"]);
    const signatures = screen.getByRole("table", { name: "서명" });
    expect(within(signatures).getByRole("rowheader", { name: "기록자" }).parentElement).toHaveTextContent("서명 전");
  });

  it("auto-saves a second after typing with If-Match, then shows it saved", async () => {
    const seen: (string | null)[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.method === "PUT") seen.push(request.headers.get("if-match"));
    });
    renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    const objective = within(await screen.findByRole("group", { name: "연구 목표" })).getAllByRole("textbox")[0]!;
    await userEvent.type(objective, " 추가 관찰");
    expect(screen.getByRole("status", { name: "저장 상태" })).toHaveTextContent("저장하지 않은 변경");
    await waitFor(() => expect(screen.getByRole("status", { name: "저장 상태" })).toHaveTextContent("저장됨"), { timeout: 4000 });
    expect(seen).toEqual(['"2"']);
    expect(draftNote().blocks.find((b) => b.section === "OBJECTIVE")!.text).toMatch(/추가 관찰$/);
    expect(draftNote().revision).toBe(3);
    server.events.removeAllListeners();
  });

  it("adds and deletes sentences in a section", async () => {
    renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    const next = await screen.findByRole("group", { name: "향후 계획" });
    await userEvent.click(within(next).getByRole("button", { name: "향후 계획에 문장 추가" }));
    const boxes = within(next).getAllByRole("textbox");
    expect(boxes).toHaveLength(2);
    await userEvent.type(boxes[1]!, "챔버 로그를 받아 대조한다.");
    await userEvent.click(within(next).getByRole("button", { name: "향후 계획 1번째 문장 삭제" }));
    await waitFor(() => expect(draftNote().blocks.filter((b) => b.section === "NEXT").map((b) => b.text)).toEqual(["챔버 로그를 받아 대조한다."]), { timeout: 4000 });
  });

  it("a save conflict keeps my text copyable and offers to reload", async () => {
    renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    const objective = within(await screen.findByRole("group", { name: "연구 목표" })).getAllByRole("textbox")[0]!;
    draftNote().revision = 7; // saved elsewhere meanwhile
    await userEvent.type(objective, " 내 문장");
    const alert = await screen.findByRole("alert", {}, { timeout: 4000 });
    expect(alert).toHaveTextContent("다른 곳에서 이 노트가 먼저 저장되었습니다");
    expect((within(alert).getByRole("textbox", { name: "저장하지 못한 내 내용" }) as HTMLTextAreaElement).value).toContain("내 문장");
    await userEvent.click(within(alert).getByRole("button", { name: "다시 불러오기" }));
    await waitFor(() => expect((within(screen.getByRole("group", { name: "연구 목표" })).getAllByRole("textbox")[0] as HTMLTextAreaElement).value).not.toContain("내 문장"));
    // The unsaved text stays on screen to copy back.
    expect((screen.getByRole("textbox", { name: "저장하지 못한 내 내용" }) as HTMLTextAreaElement).value).toContain("내 문장");
  });

  it("asks before leaving while a save is pending", async () => {
    renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    const objective = within(await screen.findByRole("group", { name: "연구 목표" })).getAllByRole("textbox")[0]!;
    await userEvent.type(objective, "x");
    await userEvent.click(screen.getByRole("link", { name: "연구노트 목록" }));
    expect(await screen.findByRole("dialog", { name: "저장하지 않은 변경이 있습니다" })).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalledWith("/commons/notes");
  });
});

describe("AI 초안", () => {
  it("is disabled with the reason when no notebook was saved today", async () => {
    renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    const button = await screen.findByRole("button", { name: "AI 초안 만들기" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("오늘 저장한 노트북이 없습니다.");
  });

  it("is hidden when the local LLM is switched off", async () => {
    getDb().llmEnabled = false;
    renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    await screen.findByRole("group", { name: "연구 목표" });
    await screen.findByRole("button", { name: "서명하고 확정" });
    expect(screen.queryByRole("button", { name: "AI 초안 만들기" })).not.toBeInTheDocument();
  });

  it("drafts from today's notebook: progress, marked AI sentences with evidence, reviewed by saving", async () => {
    seedNotebook();
    renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    const button = await screen.findByRole("button", { name: "AI 초안 만들기" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByText(/AI 초안을 만들고 있습니다|AI 초안 대기 중/)).toBeInTheDocument();
    const procedure = screen.getByRole("group", { name: "수행 내용" });
    const ai = await within(procedure).findByRole("listitem", { name: /AI 초안/ }, { timeout: 8000 });
    expect(within(ai).getByText("temp_c 주기 분석 · 셀 2")).toBeInTheDocument();
    expect(screen.getByText(/검토하지 않은 AI 문장 \d+개/)).toBeInTheDocument();
    // Submitting with unreviewed AI sentences is refused with the reason.
    expect(screen.getByRole("button", { name: /서명/ })).toBeDisabled();

    await userEvent.type(within(ai).getByRole("textbox"), " (평균)");
    await waitFor(() => expect(draftNote().blocks.filter((b) => b.origin === "AI").every((b) => b.accepted)).toBe(true), { timeout: 4000 });
    await waitFor(() => expect(screen.queryByText(/검토하지 않은 AI 문장/)).not.toBeInTheDocument());
    expect(draftNote().blocks.find((b) => b.origin === "AI" && b.section === "PROCEDURE")!.evidence[0]).toMatchObject({ type: "NOTEBOOK", label: "temp_c 주기 분석 · 셀 2" });
  });

  it("deleting an AI sentence removes it", async () => {
    seedNotebook();
    renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    const button = await screen.findByRole("button", { name: "AI 초안 만들기" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    const procedure = screen.getByRole("group", { name: "수행 내용" });
    const ai = await within(procedure).findByRole("listitem", { name: /AI 초안/ }, { timeout: 8000 });
    await userEvent.click(within(ai).getByRole("button", { name: /삭제$/ }));
    await waitFor(() => expect(draftNote().blocks.some((b) => b.origin === "AI" && b.section === "PROCEDURE")).toBe(false), { timeout: 4000 });
  });

  it("explains 422 NO_NOTEBOOK_ACTIVITY, 503 and 429", async () => {
    seedNotebook();
    let answer = errorBody("VALIDATION_FAILED", { reason: "NO_NOTEBOOK_ACTIVITY" });
    let status = 422;
    server.use(http.post("*/mock-api/v1/notes/:note_id/draft", () => HttpResponse.json(answer, { status })));
    renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    const button = await screen.findByRole("button", { name: "AI 초안 만들기" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByText("오늘 저장한 노트북이 없습니다.", { selector: "[role=alert] *, [role=alert]" })).toBeInTheDocument();

    answer = errorBody("LLM_UNAVAILABLE");
    status = 503;
    await userEvent.click(button);
    expect(await screen.findByText(/지금은 AI 초안을 만들 수 없습니다/)).toBeInTheDocument();

    answer = errorBody("RATE_LIMITED");
    status = 429;
    await userEvent.click(button);
    expect(await screen.findByText(/1분 뒤에 다시/)).toBeInTheDocument();
  });

  it("a failed draft shows the reason and leaves my sentences alone", async () => {
    Object.assign(draftNote(), { draft_status: "FAILED", draft_error: "모델 응답 시간이 초과되었습니다." });
    renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    expect(await screen.findByText("모델 응답 시간이 초과되었습니다.")).toBeInTheDocument();
    expect(screen.getByText(/AI 초안을 만들지 못했습니다/)).toBeInTheDocument();
  });
});

describe("제출·반려·서명", () => {
  it("with a witness: submit, the witness rejects with a reason, the recorder sees it", async () => {
    requireWitness();
    const view = renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    await userEvent.click(await screen.findByRole("button", { name: "제출" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "연구노트 제출" })).getByRole("button", { name: "제출" }));
    await waitFor(() => expect(draftNote().status).toBe("SUBMITTED"));
    expect(await screen.findByText("제출됨", { selector: "[data-note-status] *" })).toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    view.unmount();

    renderNotes(`/commons/notes/${NOTE.draft}`, USER.bResearcher);
    await userEvent.click(await screen.findByRole("button", { name: "반려" }));
    const dialog = await screen.findByRole("dialog", { name: "연구노트 반려" });
    await userEvent.type(within(dialog).getByLabelText("반려 사유"), "RESULTS의 온도 범위 근거를 적어 주세요.");
    await userEvent.click(within(dialog).getByRole("button", { name: "반려" }));
    await waitFor(() => expect(draftNote().status).toBe("DRAFT"));
  });

  it("the recorder sees the rejection reason on the returned draft", async () => {
    Object.assign(draftNote(), { rejected_reason: "RESULTS의 온도 범위 근거를 적어 주세요." });
    renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    expect(await screen.findByText("RESULTS의 온도 범위 근거를 적어 주세요.")).toBeInTheDocument();
    expect(screen.getByText("반려 사유")).toBeInTheDocument();
  });

  it("with a witness: the recorder signs, then the witness signs and the note is SIGNED", async () => {
    submitDraftForWitness();
    const view = renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    await userEvent.click(await screen.findByRole("button", { name: "서명" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "연구노트 서명" })).getByRole("button", { name: "서명" }));
    await waitFor(() => expect(draftNote().signatures.map((s) => s.role)).toEqual(["RECORDER"]));
    view.unmount();

    renderNotes(`/commons/notes/${NOTE.draft}`, USER.bResearcher);
    await userEvent.click(await screen.findByRole("button", { name: "서명" }));
    const dialog = await screen.findByRole("dialog", { name: "연구노트 서명" });
    expect(dialog).toHaveTextContent("확인자");
    await userEvent.click(within(dialog).getByRole("button", { name: "서명" }));
    await waitFor(() => expect(draftNote().status).toBe("SIGNED"));
    const signatures = await screen.findByRole("table", { name: "서명" });
    expect(within(signatures).getByRole("rowheader", { name: "확인자" }).parentElement).toHaveTextContent("최유진");
  });

  it("without a witness: the recorder signs the draft; SIGNED is read-only and 새 버전 opens version 2", async () => {
    renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    await userEvent.click(await screen.findByRole("button", { name: "서명하고 확정" }));
    const dialog = await screen.findByRole("dialog", { name: "연구노트 서명" });
    expect(dialog).toHaveTextContent("서명하면 내용이 고정되어 더 이상 고칠 수 없습니다");
    await userEvent.click(within(dialog).getByRole("button", { name: "서명" }));
    await waitFor(() => expect(draftNote().status).toBe("SIGNED"));
    expect(await screen.findByText("서명 완료", { selector: "[data-note-status] *" })).toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "AI 초안 만들기" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "새 버전 만들기" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/commons\/notes\/[0-9a-f-]{36}$/)));
    expect(await screen.findByText("v2")).toBeInTheDocument();
    expect(within(await screen.findByRole("group", { name: "연구 목표" })).getAllByRole("textbox")).toHaveLength(1);
  });

  it("an expired login asks to confirm again (mock mode) and then signs", async () => {
    let expired = true;
    server.use(
      http.post("*/mock-api/v1/notes/:note_id/sign", () => (expired ? HttpResponse.json(errorBody("NOTE_SIGNATURE_EXPIRED"), { status: 401 }) : undefined)),
    );
    renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    await userEvent.click(await screen.findByRole("button", { name: "서명하고 확정" }));
    const dialog = await screen.findByRole("dialog", { name: "연구노트 서명" });
    await userEvent.click(within(dialog).getByRole("button", { name: "서명" }));
    expect(await within(dialog).findByText(/로그인한 지 5분이 지났습니다/)).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalledWith(expect.stringMatching(/mock-login|blocked/));
    expired = false;
    await userEvent.click(within(dialog).getByRole("button", { name: "다시 확인하고 서명" }));
    expect(document.cookie).toMatch(new RegExp(`${MOCK_AUTH_TIME_COOKIE}=\\d+`));
    await waitFor(() => expect(draftNote().status).toBe("SIGNED"));
  });

  it("?sign=1 (back from re-authentication) reopens the sign dialog", async () => {
    renderNotes(`/commons/notes/${NOTE.draft}?sign=1`, USER.aResearcher);
    expect(await screen.findByRole("dialog", { name: "연구노트 서명" })).toBeInTheDocument();
    expect(router.replace).toHaveBeenCalledWith(`/commons/notes/${NOTE.draft}`, expect.anything());
  });

  it("NOTE_HAS_UNACCEPTED_AI from the server is explained", async () => {
    server.use(http.post("*/mock-api/v1/notes/:note_id/sign", () => HttpResponse.json(errorBody("NOTE_HAS_UNACCEPTED_AI"), { status: 409 })));
    renderNotes(`/commons/notes/${NOTE.draft}`, USER.aResearcher);
    await userEvent.click(await screen.findByRole("button", { name: "서명하고 확정" }));
    const dialog = await screen.findByRole("dialog", { name: "연구노트 서명" });
    await userEvent.click(within(dialog).getByRole("button", { name: "서명" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("수락하지 않은 AI 문장이 있습니다");
  });
});

describe("검증·내보내기", () => {
  it("verifies a signed note and reports tampering", async () => {
    renderNotes(`/commons/notes/${NOTE.signed}`, USER.aResearcher);
    await userEvent.click(await screen.findByRole("button", { name: "무결성 검증" }));
    const panel = await screen.findByRole("region", { name: "무결성 검증 결과" });
    expect(await within(panel).findByText("내용 해시 일치")).toBeInTheDocument();
    expect(within(panel).getByText("체인 일치")).toBeInTheDocument();
    expect(panel).toHaveTextContent(signedNote().content_hash!);

    signedNote().blocks[0]!.text += " (변조)";
    await userEvent.click(within(panel).getByRole("button", { name: "다시 검증" }));
    expect(await within(panel).findByText("내용 해시 불일치")).toBeInTheDocument();
    expect(within(panel).getByText("체인 불일치")).toBeInTheDocument();
  });

  it("exports the note's day as a ZIP download", async () => {
    const create = vi.fn(() => "blob:notes");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderNotes(`/commons/notes/${NOTE.signed}`, USER.aResearcher);
    await userEvent.click(await screen.findByRole("button", { name: "내보내기" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toMatch(/^research-notes-.*\.zip$/);
    expect(create).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });
});

describe("프로젝트 연구노트 탭", () => {
  const base = `/commons/projects/${PROJECT.seed}`;

  it("is a workspace tab listing the project's notes; 오늘 노트 쓰기 opens today's note", async () => {
    renderWorkspace(`${base}/notes`, USER.aResearcher);
    const tabs = await screen.findByRole("navigation", { name: "프로젝트 작업 공간" });
    expect(within(tabs).getByRole("link", { name: "연구노트" })).toHaveAttribute("aria-current", "page");
    const table = await screen.findByRole("table", { name: "내 노트" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "오늘 노트 쓰기" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/commons/notes/${NOTE.draft}`));
  });

  it("the project owner sets the witness rule", async () => {
    renderWorkspace(`${base}/notes`, USER.aResearcher);
    const settings = await screen.findByRole("region", { name: "확인자 설정" });
    await within(settings).findByRole("checkbox", { name: /최유진/ });
    await userEvent.click(within(settings).getByRole("switch", { name: "제출한 노트에 확인자 서명 받기" }));
    await userEvent.click(within(settings).getByRole("checkbox", { name: /최유진/ }));
    await userEvent.click(within(settings).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(getDb().noteSettings[PROJECT.seed]).toEqual({ witness_required: true, witness_user_ids: [USER.bResearcher] }));
  });

  it("the notes list's 오늘 노트 쓰기 picks a project first", async () => {
    renderNotes("/commons/notes", USER.aResearcher);
    await userEvent.click(await screen.findByRole("button", { name: "오늘 노트 쓰기" }));
    const dialog = await screen.findByRole("dialog", { name: "오늘 노트 쓰기" });
    await userEvent.click(await within(dialog).findByRole("button", { name: "열기" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/commons/notes/${NOTE.draft}`));
  });
});

describe("notification deep link", () => {
  it("/commons/notes/{id} opens the note for its witness", async () => {
    submitDraftForWitness();
    renderNotes(`/commons/notes/${NOTE.draft}`, USER.bResearcher);
    expect(await screen.findByRole("table", { name: "노트 정보" })).toHaveTextContent("김민준");
    expect(screen.getByRole("button", { name: "반려" })).toBeInTheDocument();
  });
});
