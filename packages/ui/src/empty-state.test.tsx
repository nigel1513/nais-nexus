import { render, screen } from "@testing-library/react";
import { Database } from "lucide-react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("shows icon tile, title, one line and one action", () => {
    const { container } = render(<EmptyState icon={Database} title="데이터셋이 없습니다" description="첫 데이터셋을 등록하세요" action={<button>새 데이터셋</button>} />);
    expect(screen.getByText("데이터셋이 없습니다")).toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "새 데이터셋" })).toBeInTheDocument();
  });
});
