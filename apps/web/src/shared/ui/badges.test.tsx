import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../../../tests/render";
import { AccessLevelBadge, ReadinessBadge, RequestStatusBadge } from "./badges";
import { DateTime } from "./date-text";

describe("badges", () => {
  it.each([
    ["PUBLIC", "공개"],
    ["INTERNAL", "기관 내부"],
    ["CONTROLLED", "통제"],
    ["SENSITIVE", "민감"],
  ] as const)("AccessLevel %s = text + icon", (level, label) => {
    const { container } = renderWithProviders(<AccessLevelBadge level={level} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelector("svg[aria-hidden='true']")).not.toBeNull();
  });

  it("readiness null reads as not validated", () => {
    renderWithProviders(<ReadinessBadge value={null} />);
    expect(screen.getByText("검증 전")).toBeInTheDocument();
  });

  it("request status label", () => {
    renderWithProviders(<RequestStatusBadge status="CHANGE_REQUESTED" />);
    expect(screen.getByText("수정 요청됨")).toBeInTheDocument();
  });

  it("DateTime shows Seoul time with the UTC original in title", () => {
    renderWithProviders(<DateTime value="2026-10-01T00:00:00Z" />);
    const time = screen.getByText("2026-10-01 09:00");
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("title", "2026-10-01T00:00:00.000Z");
  });
});
