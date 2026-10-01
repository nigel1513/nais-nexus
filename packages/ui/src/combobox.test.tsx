import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Combobox } from "./combobox";

type Org = { id: string; name: string };
const orgs: Org[] = [
  { id: "a", name: "한국전기연구원" },
  { id: "b", name: "한국기계연구원" },
  { id: "c", name: "한국화학연구원" },
];

function H() {
  const [v, setV] = useState<Org | null>(null);
  return (
    <>
      <label htmlFor="org">기관</label>
      <Combobox id="org" items={orgs} value={v} onValueChange={setV} itemToString={(o) => o.name} itemKey={(o) => o.id} emptyText="결과 없음" openLabel="목록 열기" />
      <output>{v?.id ?? "none"}</output>
    </>
  );
}

describe("Combobox", () => {
  it("filters as you type, picks with arrows + Enter, and Esc closes keeping focus in the input", async () => {
    const user = userEvent.setup();
    render(<H />);
    const input = screen.getByRole("combobox", { name: "기관" });
    await user.type(input, "기계");
    const list = await screen.findByRole("listbox");
    await waitFor(() => expect(list.querySelectorAll("[role=option]")).toHaveLength(1));
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(screen.getByText("b")).toBeInTheDocument());
    expect(input).toHaveValue("한국기계연구원");

    await user.clear(input);
    await user.type(input, "없는기관");
    expect(await screen.findByText("결과 없음")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(input).toHaveFocus();
  });
});
