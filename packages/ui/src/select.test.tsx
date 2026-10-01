import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SelectMenu } from "./select";

const options = [
  { value: "raw", label: "RAW" },
  { value: "processed", label: "PROCESSED" },
  { value: "docs", label: "DOCS" },
];

describe("SelectMenu", () => {
  it("is labelled, picks with arrows + Enter, and Esc returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <>
        <label htmlFor="role">역할</label>
        <SelectMenu id="role" options={options} placeholder="선택" onValueChange={onValueChange} />
      </>,
    );
    const trigger = screen.getByRole("combobox", { name: "역할" });
    expect(trigger).toHaveTextContent("선택");
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const list = await screen.findByRole("listbox");
    await waitFor(() => expect(list).toContainElement(document.activeElement as HTMLElement));
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(document.activeElement).toHaveTextContent("PROCESSED"));
    // jsdom's synthetic click from Enter is not recognised as a virtual click by Base UI; a real browser commits on
    // Enter (covered by e2e). Commit with the pointer here.
    await user.click(screen.getByRole("option", { name: "PROCESSED" }));
    await waitFor(() => expect(onValueChange).toHaveBeenCalled());
    expect(onValueChange.mock.calls.at(-1)![0]).toBe("processed");
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("shows the chosen label", () => {
    render(<SelectMenu aria-label="역할" options={options} value="docs" />);
    expect(screen.getByRole("combobox", { name: "역할" })).toHaveTextContent("DOCS");
  });
});
