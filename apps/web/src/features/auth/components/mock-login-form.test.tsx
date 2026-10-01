import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SEED_USERS, USER } from "@/mocks/fixtures";
import { router } from "../../../../tests/navigation";
import { renderWithProviders } from "../../../../tests/render";
import { MockLoginForm } from "./mock-login-form";

describe("MockLoginForm", () => {
  it("lists every seed user and signs in as the chosen one", async () => {
    renderWithProviders(<MockLoginForm callbackUrl="/commons/access?tab=review" users={SEED_USERS} />);
    const select = screen.getByLabelText("사용자");
    expect(select.querySelectorAll("option")).toHaveLength(8);
    await userEvent.selectOptions(select, USER.bSteward);
    await userEvent.click(screen.getByRole("button", { name: "로그인" }));
    expect(document.cookie).toContain(`nais_mock_user=${USER.bSteward}`);
    expect(router.push).toHaveBeenCalledWith("/commons/access?tab=review");
  });
});
