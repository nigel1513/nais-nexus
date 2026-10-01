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
});
