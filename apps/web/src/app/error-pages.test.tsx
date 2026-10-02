import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import ko from "@/messages/ko.json";
import { renderWithProviders } from "../../tests/render";
import BlockedPage from "./blocked/page";
import ErrorPage from "./error";
import NotFound from "./not-found";

vi.mock("next-intl/server", () => ({ getTranslations: async () => createTranslator({ locale: "ko", messages: ko }) }));

describe("error pages", () => {
  it("404 uses the empty-state pattern: code in mono, title, help and a way back", async () => {
    renderWithProviders(await NotFound());
    expect(screen.getByRole("heading", { level: 1, name: "페이지를 찾을 수 없습니다" })).toBeInTheDocument();
    expect(screen.getByText("404")).toHaveClass("font-mono");
    expect(screen.getByRole("link", { name: "대시보드로 이동" })).toHaveAttribute("href", "/commons");
    expect(screen.getByRole("link", { name: "데이터 검색" })).toHaveAttribute("href", "/commons/data");
  });

  it("blocked shows the code and announces the reason", async () => {
    renderWithProviders(await BlockedPage({ searchParams: Promise.resolve({ code: "MEMBERSHIP_DISABLED" }) }));
    expect(screen.getByRole("heading", { level: 1, name: "계정을 사용할 수 없습니다" })).toBeInTheDocument();
    expect(screen.getByText("MEMBERSHIP_DISABLED")).toHaveClass("font-mono");
    expect(screen.getByRole("alert")).toHaveTextContent(ko.errors.MEMBERSHIP_DISABLED);
  });

  it("500 shows the trace id as copyable PathText and retries", async () => {
    const reset = vi.fn();
    renderWithProviders(<ErrorPage error={Object.assign(new Error("boom"), { digest: "digest-1234567890abcdef" })} reset={reset} />);
    expect(screen.getByRole("alert")).toHaveTextContent("예기치 않은 오류");
    expect(screen.getByRole("button", { name: "추적 ID 복사" })).toBeInTheDocument();
    expect(document.body.textContent).toContain("digest-1234567890abcdef");
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(reset).toHaveBeenCalled();
  });
});
