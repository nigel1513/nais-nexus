import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "../../../tests/msw";
import { getDb } from "@/mocks/db";
import { NOTE, PROJECT, USER } from "@/mocks/fixtures";
import { seoulDate } from "@/mocks/note-hash";
import { seedNotebookActivity } from "@/mocks/notebook-activity";
import { NoteScreen } from "@/features/notes/note-screen";
import { renderScreen } from "../../../tests/render";
import { renderWorkspace } from "../../../tests/workspace-routes";
import { NotebooksScreen } from "./notebooks-screen";

const href = `/commons/projects/${PROJECT.seed}/notebook`;
const LOCATION = `/notebooks/lab/workspaces/nais-${USER.aResearcher}-${PROJECT.seed}/tree/work/${USER.aResearcher}/${PROJECT.seed}/analysis.ipynb?token=tok`;
/** What POST /notebooks-open answers in this test. */
const opener = (status: number, body: object) => server.use(http.post("*/notebooks-open", () => HttpResponse.json(body, { status })));

describe("/commons/notebooks", () => {
  it("lists my active projects with a plain 노트북 열기 link and today's notebook count", async () => {
    seedNotebookActivity({ user_id: USER.aResearcher, project_id: PROJECT.seed, day: seoulDate(), title: "분석", saved_at: new Date().toISOString(), cells: [] });
    renderScreen(<NotebooksScreen />, { user: USER.aResearcher, path: "/commons/notebooks" });
    expect(await screen.findByRole("heading", { level: 1, name: "노트북" })).toBeInTheDocument();
    const [link] = await screen.findAllByRole("link", { name: "차세대 이차전지 소재 공동연구 노트북 열기" }); // table row (+ phone card)
    if (!link) throw new Error("no link");
    expect(link).toHaveAttribute("href", href);
    expect(link).not.toHaveAttribute("target");
    const row = link.closest("tr")!;
    expect(await within(row).findByText("1개")).toBeInTheDocument(); // today's DRAFT note sees one saved notebook
  });

  it("explains the — count when today's note does not exist yet", async () => {
    getDb().notes = getDb().notes.filter((n) => n.note_date !== seoulDate());
    renderScreen(<NotebooksScreen />, { user: USER.aResearcher, path: "/commons/notebooks" });
    const [link] = await screen.findAllByRole("link", { name: "차세대 이차전지 소재 공동연구 노트북 열기" });
    const row = link!.closest("tr")!;
    expect(within(row).getByText("오늘 연구노트를 열면 표시됩니다")).toHaveClass("sr-only");
    expect(within(row).getByTitle("오늘 연구노트를 열면 표시됩니다")).toHaveTextContent("—");
  });

  it("shows the empty state to a user without projects", async () => {
    renderScreen(<NotebooksScreen />, { user: USER.aSteward, path: "/commons/notebooks" });
    expect(await screen.findByText("참여 중인 진행 프로젝트가 없습니다")).toBeInTheDocument();
  });

});

describe("workspace 노트북 tab", () => {
  it("shows JupyterLab in a frame inside the workspace; 넓게 보기 fills the window and Esc brings it back", async () => {
    opener(200, { location: LOCATION });
    renderWorkspace(href, USER.aResearcher);
    expect(await screen.findByText("노트북 폴더를 준비하고 있습니다")).toBeInTheDocument();
    const frame = await screen.findByTitle("차세대 이차전지 소재 공동연구 JupyterLab");
    expect(frame).toHaveAttribute("src", LOCATION);
    expect(screen.getByText("저장할 때마다 변경 이력이 자동으로 기록됩니다 · 왼쪽 Git 패널에서 이력과 비교를 볼 수 있습니다")).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "프로젝트 작업 공간" })).getByRole("link", { name: "노트북" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "노트북 열기" })).not.toBeInTheDocument(); // already here
    const section = frame.closest("section")!;
    await userEvent.click(screen.getByRole("button", { name: "넓게 보기" }));
    expect(section).toHaveClass("fixed");
    expect(screen.getByTitle("차세대 이차전지 소재 공동연구 JupyterLab")).toBe(frame); // the frame is not reloaded
    await userEvent.keyboard("{Escape}");
    expect(section).not.toHaveClass("fixed");
    expect(screen.getByRole("button", { name: "넓게 보기" })).toHaveAttribute("aria-pressed", "false");
  });

  it("explains an unavailable notebook server in place and opens on 다시 시도", async () => {
    opener(503, { error: "unavailable" });
    renderWorkspace(href, USER.aResearcher);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("노트북 서버에 연결할 수 없습니다");
    opener(200, { location: LOCATION });
    await userEvent.click(within(alert).getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByTitle("차세대 이차전지 소재 공동연구 JupyterLab")).toHaveAttribute("src", LOCATION);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says forbidden without a retry, and never frames an address outside /notebooks/", async () => {
    opener(403, { error: "forbidden" });
    const first = renderWorkspace(href, USER.aResearcher);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("이 프로젝트의 노트북을 열 권한이 없습니다");
    expect(within(alert).queryByRole("button")).not.toBeInTheDocument();
    first.unmount();
    opener(200, { location: "https://evil.test/" });
    const { container } = renderWorkspace(href, USER.aResearcher);
    expect(await screen.findByRole("alert")).toHaveTextContent("노트북 서버에 연결할 수 없습니다");
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("does not ask the notebook server for an archived project", async () => {
    getDb().projects.find((p) => p.project_id === PROJECT.seed)!.status = "ARCHIVED";
    renderWorkspace(href, USER.aResearcher); // an unhandled POST would fail the test
    expect(await screen.findByText("보관된 프로젝트는 노트북을 열 수 없습니다")).toBeInTheDocument();
  });
});

describe("노트북 열기 elsewhere", () => {
  it("is in the project workspace header for members", async () => {
    renderWorkspace(`/commons/projects/${PROJECT.seed}`, USER.aResearcher);
    expect(await screen.findByRole("link", { name: "노트북 열기" })).toHaveAttribute("href", href);
  });

  it("sits next to AI 초안 on today's note; the disabled reason stays", async () => {
    renderScreen(<NoteScreen noteId={NOTE.draft} />, { user: USER.aResearcher, path: `/commons/notes/${NOTE.draft}` });
    const button = await screen.findByRole("button", { name: "AI 초안 만들기" });
    expect(button).toHaveAccessibleDescription(/^이 프로젝트에서 오늘\(\d{4}-\d{2}-\d{2}\) 저장한 노트북이 없습니다\. 노트북 탭에서 이 프로젝트의 노트북을 저장한 뒤 다시 시도하세요\.$/);
    expect(screen.getByRole("link", { name: "노트북 열기" })).toHaveAttribute("href", href);
  });

  it("is not offered on a signed note", async () => {
    renderScreen(<NoteScreen noteId={NOTE.signed} />, { user: USER.aResearcher, path: `/commons/notes/${NOTE.signed}` });
    await screen.findByRole("button", { name: /검증/ });
    expect(screen.queryByRole("link", { name: "노트북 열기" })).not.toBeInTheDocument();
  });
});
