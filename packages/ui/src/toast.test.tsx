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
  it("announces errors assertively and everything else politely, in Sonner's one live region", async () => {
    const { container } = render(<Toaster closeLabel="닫기" />);
    const region = () => container.ownerDocument.querySelector("section[aria-live]")!;
    act(() => {
      notify.success("저장했습니다");
    });
    expect(await screen.findByText("저장했습니다")).toBeInTheDocument();
    expect(region()).toHaveAttribute("aria-live", "polite");
    act(() => {
      notify.error("저장하지 못했습니다");
    });
    expect(await screen.findByText("저장하지 못했습니다")).toBeInTheDocument();
    expect(region()).toHaveAttribute("aria-live", "assertive");
    act(() => {
      notify.info("다시 연결했습니다");
    });
    expect(region()).toHaveAttribute("aria-live", "polite");
    act(() => notify.dismiss());
  });
});
