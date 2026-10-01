import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandMenu } from "./command";

describe("CommandMenu", () => {
  it("filters, moves with arrows and runs the item on Enter", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <CommandMenu.Root label="명령">
        <CommandMenu.Input placeholder="검색" />
        <CommandMenu.List>
          <CommandMenu.Empty>결과 없음</CommandMenu.Empty>
          <CommandMenu.Group heading="이동">
            <CommandMenu.Item onSelect={() => onSelect("dash")}>대시보드</CommandMenu.Item>
            <CommandMenu.Item onSelect={() => onSelect("data")}>데이터</CommandMenu.Item>
          </CommandMenu.Group>
        </CommandMenu.List>
      </CommandMenu.Root>,
    );
    const input = screen.getByPlaceholderText("검색");
    await user.click(input);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith("data");
    await user.type(input, "zzz");
    expect(screen.getByText("결과 없음")).toBeInTheDocument();
  });
  it("Dialog opens with no animation classes", () => {
    render(
      <CommandMenu.Dialog open onOpenChange={() => {}} label="명령 팔레트">
        <CommandMenu.Input placeholder="검색" />
      </CommandMenu.Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "명령 팔레트" });
    expect(dialog.className).not.toMatch(/transition|starting-style/);
  });
});
