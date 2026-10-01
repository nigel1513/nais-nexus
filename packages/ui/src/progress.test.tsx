import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Progress } from "./progress";

describe("Progress", () => {
  it("is a named progressbar that fills with scaleX", () => {
    render(<Progress label="업로드" value={25} valueText="1 / 4 파일" />);
    const bar = screen.getByRole("progressbar", { name: "업로드" });
    expect(bar).toHaveAttribute("aria-valuenow", "25");
    expect(bar).toHaveAttribute("aria-valuetext", "1 / 4 파일");
    expect((bar.firstElementChild as HTMLElement).style.transform).toBe("scaleX(0.25)");
  });
  it("omits aria-valuenow when indeterminate", () => {
    render(<Progress label="검증" value={null} />);
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });
});
