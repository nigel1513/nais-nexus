import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { SearchCombobox } from "./search-combobox";

type P = { id: string; name: string };
const people: P[] = [
  { id: "1", name: "김연구" },
  { id: "2", name: "김연희" },
  { id: "3", name: "박측정" },
];

function H({ restore }: { restore?: boolean }) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<P | null>(null);
  const items = text.length < 1 ? [] : people.filter((p) => p.name.includes(text));
  return (
    <>
      <label htmlFor="pi">연구책임자</label>
      <SearchCombobox
        id="pi"
        items={items}
        value={picked}
        inputValue={text}
        onInputChange={(t) => {
          setText(t);
          setPicked(null);
        }}
        onPick={(p) => {
          setPicked(p);
          setText(p.name);
        }}
        onBlur={() => {
          if (restore && !picked) setText("복원됨");
        }}
        itemToString={(p) => p.name}
        itemKey={(p) => p.id}
        renderItem={(p) => <span>{p.name} · NTIS {p.id}</span>}
        emptyText="1자 이상 입력하세요"
        footer="소유 기관 구성원만"
        status={`${items.length}명`}
      />
      <output>{picked?.id ?? "none"}</output>
    </>
  );
}

describe("SearchCombobox", () => {
  it("shows caller-filtered rows with a footer, picks with arrows + Enter and keeps the caller's text", async () => {
    const user = userEvent.setup();
    render(<H />);
    const input = screen.getByRole("combobox", { name: "연구책임자" });
    await user.type(input, "김연");
    expect(await screen.findByRole("option", { name: /김연희 · NTIS 2/ })).toBeInTheDocument();
    expect(screen.getByText("소유 기관 구성원만")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(screen.getByText("2")).toBeInTheDocument());
    expect(input).toHaveValue("김연희");
  });

  it("does not rewrite typed text on blur; the caller decides", async () => {
    const user = userEvent.setup();
    render(<H />);
    const input = screen.getByRole("combobox", { name: "연구책임자" });
    await user.type(input, "zz");
    await user.tab();
    expect(input).toHaveValue("zz");
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("lets the caller restore text on blur", async () => {
    const user = userEvent.setup();
    render(<H restore />);
    const input = screen.getByRole("combobox", { name: "연구책임자" });
    await user.type(input, "zz");
    await user.tab();
    expect(input).toHaveValue("복원됨");
  });

  it("clicking an option picks it", async () => {
    const user = userEvent.setup();
    render(<H />);
    await user.type(screen.getByRole("combobox", { name: "연구책임자" }), "박");
    await user.click(await screen.findByRole("option", { name: /박측정/ }));
    await waitFor(() => expect(screen.getByText("3")).toBeInTheDocument());
  });

  it("Enter right after results arrive picks the first one", async () => {
    const user = userEvent.setup();
    render(<H />);
    await user.type(screen.getByRole("combobox", { name: "연구책임자" }), "박");
    await screen.findByRole("option", { name: /박측정/ });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText("3")).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
  });

  it("pressing a row does not count as leaving without a pick", async () => {
    const user = userEvent.setup();
    render(<H restore />);
    const input = screen.getByRole("combobox", { name: "연구책임자" });
    await user.type(input, "박");
    await user.click(await screen.findByRole("option", { name: /박측정/ }));
    await waitFor(() => expect(screen.getByText("3")).toBeInTheDocument());
    expect(input).toHaveValue("박측정");
  });
});
