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
    expect(screen.queryByRole("alert")).toBeNull();
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
});
