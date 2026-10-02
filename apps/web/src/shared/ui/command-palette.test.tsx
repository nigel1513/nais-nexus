import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PlatformShell } from "@/features/shell/platform-shell";
import { DATASET, PROJECT, USER } from "@/mocks/fixtures";
import { router } from "../../../tests/navigation";
import { renderWithProviders } from "../../../tests/render";
import { ThemeProvider } from "./theme";

const page = <h1>본문</h1>;

async function openWithShortcut(init: { metaKey?: boolean; ctrlKey?: boolean } = { metaKey: true }) {
  await screen.findByRole("heading", { name: "본문" });
  fireEvent.keyDown(document, { key: "k", ...init });
  return screen.findByRole("dialog", { name: "명령 팔레트" });
}

const options = (dialog: HTMLElement) => within(dialog).queryAllByRole("option").map((o) => o.textContent);

describe("CommandPalette", () => {
  it("⌘K and Ctrl+K toggle it, with no open/close animation", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    const dialog = await openWithShortcut();
    expect(dialog.className).not.toMatch(/transition|animate|starting-style/);
    await waitFor(() => expect(within(dialog).getByRole("combobox")).toHaveFocus());
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "명령 팔레트" })).not.toBeInTheDocument());
    await openWithShortcut({ ctrlKey: true });
  });

  it("lists every screen; typing filters; Enter goes there and closes", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    const dialog = await openWithShortcut();
    expect(within(dialog).getByRole("group", { name: "이동" })).toBeInTheDocument();
    expect(options(dialog)).toEqual(expect.arrayContaining(["대시보드", "프로젝트", "데이터", "접근 관리", "활동", "설정"]));
    expect(options(dialog)).not.toContain("기관 관리");
    await userEvent.type(within(dialog).getByRole("combobox"), "활동");
    // The screen first; free-text search in data is always offered last-resort below it.
    expect(options(dialog)).toEqual(["활동", "데이터에서 “활동” 검색"]);
    await userEvent.keyboard("{Enter}");
    expect(router.push).toHaveBeenCalledWith("/commons/activity");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "명령 팔레트" })).not.toBeInTheDocument());
  });

  it("arrow keys move through results; Enter opens a dataset found by the server search", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    const dialog = await openWithShortcut();
    await userEvent.type(within(dialog).getByRole("combobox"), "battery cycling");
    const hit = await within(dialog).findByRole("option", { name: /Battery Cycling Measurements/ });
    const searchAll = within(dialog).getByRole("option", { name: "데이터에서 “battery cycling” 검색" });
    expect(searchAll).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}");
    expect(hit).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");
    expect(router.push).toHaveBeenCalledWith(`/commons/data/${DATASET.battery}`);
  });

  it("the search-all row goes to data search with q", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    const dialog = await openWithShortcut();
    await userEvent.type(within(dialog).getByRole("combobox"), "battery");
    await within(dialog).findByRole("option", { name: "데이터에서 “battery” 검색" });
    await userEvent.keyboard("{Enter}");
    expect(router.push).toHaveBeenCalledWith("/commons/data?q=battery");
  });

  it("finds my projects by name", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    const dialog = await openWithShortcut();
    await userEvent.type(within(dialog).getByRole("combobox"), "joint study");
    const project = await within(within(dialog).getByRole("group", { name: "프로젝트" })).findByRole("option", { name: /Seed: Battery Materials Joint Study/ });
    await userEvent.click(project);
    expect(router.push).toHaveBeenCalledWith(`/commons/projects/${PROJECT.seed}`);
  });

  it("actions follow the role: 새 데이터셋 for stewards only", async () => {
    const { unmount } = renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    let dialog = await openWithShortcut();
    let actions = within(dialog).getByRole("group", { name: "행동" });
    expect(within(actions).queryByRole("option", { name: "새 데이터셋" })).not.toBeInTheDocument();
    expect(within(actions).getByRole("option", { name: "새 프로젝트" })).toBeInTheDocument();
    unmount();
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.bSteward });
    dialog = await openWithShortcut();
    actions = within(dialog).getByRole("group", { name: "행동" });
    await userEvent.click(within(actions).getByRole("option", { name: "새 데이터셋" }));
    expect(router.push).toHaveBeenCalledWith("/commons/data/new");
  });

  it("switches the theme", async () => {
    renderWithProviders(
      <ThemeProvider>
        <PlatformShell>{page}</PlatformShell>
      </ThemeProvider>,
      { user: USER.aResearcher },
    );
    const dialog = await openWithShortcut();
    await userEvent.click(within(dialog).getByRole("option", { name: "다크 테마로 전환" }));
    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
    document.documentElement.classList.remove("dark");
    window.localStorage.removeItem("nais-theme");
  });

  it("the top-bar button opens it; Escape closes and returns focus to the button", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    const button = await screen.findByRole("button", { name: /^검색/ });
    await userEvent.click(button);
    expect(await screen.findByRole("dialog", { name: "명령 팔레트" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "명령 팔레트" })).not.toBeInTheDocument());
    await waitFor(() => expect(button).toHaveFocus());
  });

  it("with no match anywhere, only the data search row remains", async () => {
    renderWithProviders(<PlatformShell>{page}</PlatformShell>, { user: USER.aResearcher });
    const dialog = await openWithShortcut();
    await userEvent.type(within(dialog).getByRole("combobox"), "zzzzqqq");
    await waitFor(() => expect(within(dialog).queryByRole("option", { name: /Battery/ })).not.toBeInTheDocument());
    expect(options(dialog)).toEqual(["데이터에서 “zzzzqqq” 검색"]);
  });
});
