import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Trash } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { IconButton } from "./icon-button";
import { TooltipProvider } from "./tooltip";

describe("IconButton", () => {
  it("is named by its label and shows it as a tooltip on keyboard focus", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <TooltipProvider delay={0}>
        <IconButton label="삭제" onClick={onClick}>
          <Trash />
        </IconButton>
      </TooltipProvider>,
    );
    const b = screen.getByRole("button", { name: "삭제" });
    await user.tab();
    expect(b).toHaveFocus();
    // aria-label is not text content, so visible "삭제" text can only be the tooltip popup.
    expect(await screen.findByText("삭제")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledOnce();
    expect(b.className).toContain("w-8");
  });
  it("still shows its tooltip when disabled (hover lands on a wrapping span)", () => {
    render(
      <IconButton label="삭제 권한 없음" disabled>
        <Trash />
      </IconButton>,
    );
    const b = screen.getByRole("button", { name: "삭제 권한 없음" });
    expect(b).toBeDisabled();
    expect(b.parentElement!.tagName).toBe("SPAN");
    expect(b.parentElement).toHaveAttribute("data-base-ui-tooltip-trigger");
  });
});
