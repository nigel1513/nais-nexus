import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

describe("Markdown", () => {
  it("renders GFM but never raw HTML or javascript: links", () => {
    const { container } = render(
      <Markdown source={"# 제목\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script><img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) [ok](https://example.org)"} />,
    );
    expect(container.querySelector("h3")?.textContent).toBe("제목");
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("script, img")).toBeNull();
    const links = [...container.querySelectorAll("a")];
    expect(links.find((a) => a.textContent === "x")?.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
    expect(links.find((a) => a.textContent === "ok")).toHaveAttribute("rel", "noopener noreferrer");
  });
  it("demotes headings so the page keeps one h1", () => {
    const { container } = render(<Markdown source={"# A\n## B"} />);
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h3")?.textContent).toBe("A");
    expect(container.querySelector("h4")?.textContent).toBe("B");
  });
});
