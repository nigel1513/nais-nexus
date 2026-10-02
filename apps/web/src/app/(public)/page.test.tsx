import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lookup } from "@/i18n/messages";
import ko from "@/messages/ko.json";
import { renderWithProviders } from "../../../tests/render";
import LandingPage from "./page";

// Real ko messages, so a missing key fails here instead of rendering the key.
vi.mock("next-intl/server", () => ({
  getTranslations: async (ns?: string) => (key: string) => {
    const value = lookup(ko, ns ? `${ns}.${key}` : key);
    if (typeof value !== "string") throw new Error(`missing message ${ns}.${key}`);
    return value;
  },
}));

async function renderPage() {
  return renderWithProviders(await LandingPage());
}

describe("public landing", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("has one way in: NST SSO through /commons (middleware picks Keycloak or the demo login)", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "disabled");
    await renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("NAIS Research Commons");
    expect(screen.getByRole("link", { name: "NST 통합 로그인 (SSO)" })).toHaveAttribute("href", "/commons");
    expect(screen.queryByText("데모 모드")).not.toBeInTheDocument();
    expect(screen.getByText(/소속 기관 계정으로 로그인합니다/)).toBeInTheDocument();
  });

  it("says so when the build is a demo", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "enabled");
    await renderPage();
    expect(screen.getByText("데모 모드")).toBeInTheDocument();
    expect(screen.getByText(/데모 사용자 선택 화면/)).toBeInTheDocument();
  });

  it("lists what the portal holds as text, not cards with numbers", async () => {
    await renderPage();
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["연구 데이터", "공동 프로젝트", "접근 승인", "AI-ready 검증"]);
  });

  it("labels the figure as generated sample data", async () => {
    await renderPage();
    expect(screen.getByRole("img", { name: /예시 열 분포/ })).toBeInTheDocument();
    expect(screen.getByText(/실제 데이터가 아닙니다/)).toBeInTheDocument();
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
