import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "./sheet";

describe("Sheet", () => {
  it("slides from its side, is named by its title, and the close button returns focus", async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>메뉴</SheetTrigger>
        <SheetContent side="left" closeLabel="닫기">
          <SheetHeader>
            <SheetTitle>탐색</SheetTitle>
          </SheetHeader>
          <SheetBody>링크</SheetBody>
        </SheetContent>
      </Sheet>,
    );
    const trigger = screen.getByRole("button", { name: "메뉴" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "탐색" });
    expect(dialog.className).toContain("data-[starting-style]:-translate-x-full");
    await user.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
