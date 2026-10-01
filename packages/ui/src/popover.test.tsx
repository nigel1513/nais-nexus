import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "./popover";

describe("Popover", () => {
  it("opens as a named dialog anchored to its trigger and Esc returns focus", async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger>알림</PopoverTrigger>
        <PopoverContent>
          <PopoverTitle>알림</PopoverTitle>
          <PopoverDescription>새 알림이 없습니다</PopoverDescription>
        </PopoverContent>
      </Popover>,
    );
    const trigger = screen.getByRole("button", { name: "알림" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "알림" });
    expect(dialog.className).toContain("origin-[var(--transform-origin)]");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
