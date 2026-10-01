import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { USER, VERSION } from "@/mocks/fixtures";
import { server } from "../../../../tests/msw";
import { renderWithProviders } from "../../../../tests/render";
import { AiReadyBadge } from "./ai-ready-badge";

describe("AiReadyBadge", () => {
  it("shows the score and expands the per-check list", async () => {
    renderWithProviders(<AiReadyBadge versionId={VERSION.battery} />, { user: USER.bResearcher });
    const button = await screen.findByRole("button", { name: /AI-ready \d+(\.\d)?\/10/ });
    await userEvent.click(button);
    expect(await screen.findByRole("list")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");
  });
  it("shows 미검증 when there is no completed run", async () => {
    server.use(http.get("*/dataset-versions/:id/readiness", () => HttpResponse.json({ items: [] })));
    renderWithProviders(<AiReadyBadge versionId={VERSION.battery} />, { user: USER.bResearcher });
    expect(await screen.findByText(/미검증/)).toBeInTheDocument();
  });
  it("shows a pending label, not 미검증, while readiness is loading", async () => {
    server.use(http.get("*/dataset-versions/:id/readiness", () => new Promise(() => {})));
    renderWithProviders(<AiReadyBadge versionId={VERSION.battery} />, { user: USER.bResearcher });
    expect(await screen.findByRole("button", { name: "AI-ready 확인 중" })).toBeDisabled();
    expect(screen.queryByText(/미검증/)).not.toBeInTheDocument();
  });
  it("shows an explicit failure state when readiness cannot be loaded", async () => {
    server.use(http.get("*/dataset-versions/:id/readiness", () => HttpResponse.json({ error: { code: "INTERNAL", message: "x", trace_id: "t" } }, { status: 500 })));
    renderWithProviders(<AiReadyBadge versionId={VERSION.battery} />, { user: USER.bResearcher });
    expect(await screen.findByRole("button", { name: "AI-ready 확인 실패" })).toBeDisabled();
    expect(screen.queryByText(/미검증/)).not.toBeInTheDocument();
  });
});
