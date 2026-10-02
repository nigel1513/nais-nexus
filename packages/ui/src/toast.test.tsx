import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { notify, Toaster } from "./toast";

describe("notify", () => {
  it("renders our markup; errors stay until closed with the labelled button", async () => {
    const user = userEvent.setup();
    render(<Toaster closeLabel="닫기" />);
    act(() => {
      notify.error("업로드 실패", { description: "네트워크 오류" });
    });
    expect(await screen.findByText("업로드 실패")).toBeInTheDocument();
    expect(screen.getByText("네트워크 오류")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1)); // only the Toaster's own region, none per card
    await user.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByText("업로드 실패")).toBeNull());
    act(() => notify.dismiss());
  });
  it("promise goes from loading to success", async () => {
    render(<Toaster closeLabel="닫기" />);
    let resolve!: (v: number) => void;
    act(() => {
      void notify.promise(new Promise<number>((r) => (resolve = r)), { loading: "검증 중", success: (n) => `${n}개 검증됨`, error: "실패" });
    });
    expect(await screen.findByText("검증 중")).toBeInTheDocument();
    await act(async () => resolve(3));
    expect(await screen.findByText("3개 검증됨")).toBeInTheDocument();
    act(() => notify.dismiss());
  });
  it("errors go to the alert region at once; other toasts stay in Sonner's polite region, even in the same tick", async () => {
    render(<Toaster closeLabel="닫기" />);
    act(() => {
      notify.error("저장하지 못했습니다", { description: "네트워크 오류" });
      notify.info("다시 연결했습니다");
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("저장하지 못했습니다 네트워크 오류"));
    expect(screen.getByRole("alert")).not.toHaveTextContent("다시 연결했습니다");
    const polite = document.querySelector("section[aria-live]")!;
    expect(polite).toHaveAttribute("aria-live", "polite");
    await waitFor(() => expect(polite).toHaveTextContent("다시 연결했습니다"));
    // The error card's own text is hidden from assistive tech so it is not read a second time, politely.
    const card = [...polite.querySelectorAll("[aria-hidden=true]")].find((n) => n.textContent?.includes("저장하지 못했습니다"));
    expect(card).toBeTruthy();
    act(() => notify.dismiss());
  });
});
