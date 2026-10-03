import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { getDb } from "@/mocks/db";
import { NOTE, PROJECT, USER } from "@/mocks/fixtures";
import { seoulDate } from "@/mocks/note-hash";
import { seedNotebookActivity } from "@/mocks/notebook-activity";
import { NoteScreen } from "@/features/notes/note-screen";
import { renderScreen } from "../../../tests/render";
import { renderWorkspace } from "../../../tests/workspace-routes";
import { NotebooksScreen } from "./notebooks-screen";

const href = `/notebooks-open?project=${PROJECT.seed}`;

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
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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

  it.each([
    ["unavailable", "노트북 서버에 연결할 수 없습니다"],
    ["forbidden", "이 프로젝트의 노트북을 열 권한이 없습니다"],
    ["archived", "보관된 프로젝트는 노트북을 열 수 없습니다"],
  ])("explains ?notebook_error=%s inline, and the alert can be dismissed", async (code, text) => {
    renderScreen(<NotebooksScreen />, { user: USER.aResearcher, path: `/commons/notebooks?notebook_error=${code}` });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text);
    await userEvent.click(within(alert).getByRole("button", { name: "알림 닫기" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "노트북" })).toHaveFocus(); // focus is not lost with the alert
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
    expect(button).toHaveAccessibleDescription("오늘 저장한 노트북이 없습니다.");
    expect(screen.getByRole("link", { name: "노트북 열기" })).toHaveAttribute("href", href);
  });

  it("is not offered on a signed note", async () => {
    renderScreen(<NoteScreen noteId={NOTE.signed} />, { user: USER.aResearcher, path: `/commons/notes/${NOTE.signed}` });
    await screen.findByRole("button", { name: /검증/ });
    expect(screen.queryByRole("link", { name: "노트북 열기" })).not.toBeInTheDocument();
  });
});
