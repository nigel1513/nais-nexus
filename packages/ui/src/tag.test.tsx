import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Tag } from "./tag";

describe("Tag", () => {
  it("removes with a named button", async () => {
    const onRemove = vi.fn();
    render(<Tag onRemove={onRemove} removeLabel="배터리 제거">배터리</Tag>);
    await userEvent.setup().click(screen.getByRole("button", { name: "배터리 제거" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
