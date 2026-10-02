import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ko from "@/messages/ko.json";
import { renderWithProviders } from "../../../tests/render";
import LandingPage from "./page";

// Real ko messages through next-intl's own translator, so a missing key or broken rich tag fails here.
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  return { getTranslations: async (namespace?: string) => createTranslator({ locale: "ko", messages: ko, namespace: namespace as never }) };
});

async function renderPage() {
  return renderWithProviders(await LandingPage());
}

describe("public landing", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("has one way in: NST SSO through /commons (middleware picks Keycloak or the demo login)", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "disabled");
    await renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("데이터를 찾고, 승인받고, 함께 연구합니다");
    const signIns = screen.getAllByRole("link", { name: /NST 통합 로그인/ });
    expect(signIns.length).toBeGreaterThanOrEqual(2);
    for (const link of signIns) expect(link).toHaveAttribute("href", "/commons");
    expect(screen.getByText("소속 기관 계정으로 로그인합니다")).toBeInTheDocument();
  });

  it("reads the same in the demo build: no demo badge or demo wording", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "enabled");
    await renderPage();
    expect(document.body.textContent).not.toMatch(/데모|demo/i);
    expect(screen.getByText("소속 기관 계정으로 로그인합니다")).toBeInTheDocument();
  });

  it("walks through what the portal does, one section each", async () => {
    await renderPage();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "열어 보기 전에 데이터를 압니다",
      "승인된 범위 안에서만 열립니다",
      "기관을 넘는 공동 프로젝트",
      "AI 학습에 쓰기 전에 검증합니다",
      "NST 통합 로그인으로 들어갑니다",
    ]);
  });

  it("labels every product panel as an example", async () => {
    await renderPage();
    expect(screen.getAllByText(/^화면 예시입니다/)).toHaveLength(4);
    expect(screen.getAllByRole("img", { name: /예시 열 분포/ }).length).toBeGreaterThanOrEqual(1);
  });

  it("the access demo shows what each decision leaves in the history and lights the step it moves to", async () => {
    await renderPage();
    const panel = screen.getByText("접근 요청 #2026-0142").closest(".lp-panel") as HTMLElement;
    act(() => within(panel).getByRole("button", { name: "승인" }).click());
    expect(await within(panel).findByRole("status")).toHaveTextContent("승인됨 · 2027-03-31까지");
    expect(within(panel).getByText("기간 종료 시 자동으로 닫힘")).toBeInTheDocument();
    // The step list follows the demo: an approved request is in "이용".
    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent(/^이용\./);
    act(() => within(panel).getByRole("button", { name: "처음으로" }).click());
    expect(await within(panel).findByRole("button", { name: "승인" })).toBeInTheDocument();
    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent(/^검토\./);
  });

  it("links the operator only when NAIS_OPERATOR_URL is a valid http(s) URL", async () => {
    vi.stubEnv("NAIS_OPERATOR_URL", "javascript:alert(1)");
    const { unmount } = await renderPage();
    expect(screen.queryByRole("link", { name: /국가과학AI연구센터/ })).not.toBeInTheDocument();
    unmount();
    vi.stubEnv("NAIS_OPERATOR_URL", "https://operator.example.org/");
    await renderPage();
    const links = screen.getAllByRole("link", { name: /국가과학AI연구센터/ });
    expect(links).toHaveLength(3); // header, hero line, footer
    for (const link of links) {
      expect(link).toHaveAttribute("href", "https://operator.example.org/");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("shows the audit notice, the version and the support contact slot", async () => {
    await renderPage();
    expect(screen.getByText("이 시스템은 NST 연구회 소속 연구자 전용입니다. 접속 기록이 감사 로그에 남습니다.")).toBeInTheDocument();
    expect(screen.getByText(/^v\d+\.\d+\.\d+$/)).toBeInTheDocument();
    expect(screen.getByText("연락처 준비 중")).toBeInTheDocument();
  });

  it("links the support contact when NAIS_SUPPORT_CONTACT is an e-mail", async () => {
    vi.stubEnv("NAIS_SUPPORT_CONTACT", "support@example.org");
    await renderPage();
    expect(screen.getByRole("link", { name: "support@example.org" })).toHaveAttribute("href", "mailto:support@example.org");
  });
});
