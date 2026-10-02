import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Menu } from "./menu";

describe("Menu", () => {
  it("opens from the keyboard, moves with arrows, picks with Enter, and Esc returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <Menu.Root>
        <Menu.Trigger>작업</Menu.Trigger>
        <Menu.Content>
          <Menu.Item onClick={onEdit}>편집</Menu.Item>
          <Menu.Separator />
          <Menu.Item tone="danger" onClick={onDelete}>
            삭제
          </Menu.Item>
        </Menu.Content>
      </Menu.Root>,
    );
    const trigger = screen.getByRole("button", { name: "작업" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(menu).toContainElement(document.activeElement as HTMLElement));
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "삭제" })).toHaveAttribute("data-highlighted"));
    await user.keyboard("{Enter}");
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onEdit).not.toHaveBeenCalled();

    await user.click(trigger);
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
  it("radio items report the choice and stay open", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Menu.Root>
        <Menu.Trigger>테마</Menu.Trigger>
        <Menu.Content>
          <Menu.RadioGroup value="system" onValueChange={onValueChange}>
            <Menu.RadioItem value="system">시스템</Menu.RadioItem>
            <Menu.RadioItem value="dark">다크</Menu.RadioItem>
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Root>,
    );
    await user.click(screen.getByRole("button", { name: "테마" }));
    expect(await screen.findByRole("menuitemradio", { name: "시스템" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemradio", { name: "다크" }));
    expect(onValueChange).toHaveBeenCalledWith("dark");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});

