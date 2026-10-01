import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { copyText, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogTitle, DataTable, ErrorState, FileDropzone, FormField, Input, StatusBadge } from "./index";

describe("StatusBadge", () => {
  it("renders text label plus a decorative icon (never color alone)", () => {
    const { container } = render(<StatusBadge tone="warning" label="통제" />);
    expect(screen.getByText("통제")).toBeInTheDocument();
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });
});

describe("ErrorState", () => {
  it("announces assertively, copies the trace id and retries", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onRetry = vi.fn();
    render(
      <ErrorState
        title="오류"
        message="찾을 수 없거나 접근 권한이 없습니다."
        traceId="trace-123"
        traceIdLabel="추적 ID"
        copyLabel="추적 ID 복사"
        copiedLabel="복사됨"
        copyFailedLabel="복사 실패"
        retryLabel="다시 시도"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("찾을 수 없거나 접근 권한이 없습니다.");
    await user.click(screen.getByRole("button", { name: "추적 ID 복사" }));
    expect(writeText).toHaveBeenCalledWith("trace-123");
    expect(await screen.findByText("복사됨")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("ConfirmDialog", () => {
  function Harness({ onConfirm }: { onConfirm: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>보관</button>
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="프로젝트 보관"
          description="보관 시 모든 데이터 접근 권한이 즉시 회수됩니다"
          confirmLabel="보관"
          cancelLabel="취소"
          closeLabel="닫기"
          destructive
          onConfirm={onConfirm}
        />
      </>
    );
  }

  it("confirms, and Escape closes and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const trigger = screen.getByRole("button", { name: "보관" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "프로젝트 보관" });
    expect(dialog).toHaveTextContent("즉시 회수됩니다");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(trigger);
    await user.click(screen.getAllByRole("button", { name: "보관" }).at(-1)!);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("disables confirm while pending (no double submit)", async () => {
    render(
      <ConfirmDialog open onOpenChange={() => {}} title="t" confirmLabel="확인" cancelLabel="취소" closeLabel="닫기" pending onConfirm={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "확인" })).toBeDisabled();
  });
});

describe("DataTable", () => {
  const rows = [{ id: "1", name: "Alpha" }, { id: "2", name: "Beta" }];
  it("renders caption and column headers with scope", () => {
    render(
      <DataTable caption="프로젝트 목록" rows={rows} rowKey={(r) => r.id} columns={[{ key: "name", header: "이름", cell: (r) => r.name }]} />,
    );
    const table = screen.getByRole("table", { name: "프로젝트 목록" });
    expect(table.querySelector("th")).toHaveAttribute("scope", "col");
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
  });
  it("renders the empty slot when there are no rows", () => {
    render(<DataTable caption="c" rows={[]} rowKey={() => "x"} columns={[]} empty={<p>없음</p>} />);
    expect(screen.getByText("없음")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("FormField", () => {
  it("links label and error to the control", () => {
    render(
      <FormField id="name" label="이름" required requiredLabel="(필수)" error="2자 이상 입력하세요">
        {(a11y) => <Input {...a11y} />}
      </FormField>,
    );
    const input = screen.getByLabelText(/이름/);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("2자 이상 입력하세요");
    expect(screen.getByText("(필수)")).toBeInTheDocument();
  });
});

describe("FileDropzone", () => {
  it("offers a button alternative to drag and drop (WCAG 2.5.7)", async () => {
    const user = userEvent.setup();
    const onFiles = vi.fn();
    render(<FileDropzone label="파일 올리기" fileButtonLabel="파일 선택" folderButtonLabel="폴더 선택" onFiles={onFiles} />);
    const file = new File(["a,b\n1,2\n"], "data.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("파일 선택"), file);
    expect(onFiles).toHaveBeenCalledWith([file]);
  });
});

describe("Dialog focus management", () => {
  it("keeps focus inside the dialog under StrictMode", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      function H() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <button onClick={() => setOpen(true)}>열기</button>
            <ConfirmDialog open={open} onOpenChange={setOpen} title="t" confirmLabel="확인" cancelLabel="취소" closeLabel="닫기" onConfirm={() => {}} />
          </>
        );
      }
      render(
        <StrictMode>
          <H />
        </StrictMode>,
      );
      await user.click(screen.getByRole("button", { name: "열기" }));
      await act(async () => {
        vi.runAllTimers();
      });
      expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns focus to the inner opener when a nested dialog closes, then to the outer trigger", async () => {
    const user = userEvent.setup();
    function H() {
      const [outer, setOuter] = useState(false);
      const [inner, setInner] = useState(false);
      return (
        <>
          <button onClick={() => setOuter(true)}>outer-trigger</button>
          <Dialog open={outer} onOpenChange={setOuter}>
            <DialogContent closeLabel="닫기-외부">
              <DialogTitle>외부</DialogTitle>
              <DialogDescription>d</DialogDescription>
              <button onClick={() => setInner(true)}>inner-trigger</button>
            </DialogContent>
          </Dialog>
          <Dialog open={inner} onOpenChange={setInner}>
            <DialogContent closeLabel="닫기-내부">
              <DialogTitle>내부</DialogTitle>
              <DialogDescription>d</DialogDescription>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<H />);
    const outerTrigger = screen.getByRole("button", { name: "outer-trigger" });
    await user.click(outerTrigger);
    const innerTrigger = await screen.findByRole("button", { name: "inner-trigger" });
    await user.click(innerTrigger);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "내부" })).not.toBeInTheDocument());
    await waitFor(() => expect(innerTrigger).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(outerTrigger).toHaveFocus());
  });

  it("returns focus to the opener of the current open, not the first one", async () => {
    const user = userEvent.setup();
    function H() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>row-A</button>
          <button onClick={() => setOpen(true)}>row-B</button>
          <ConfirmDialog open={open} onOpenChange={setOpen} title="t" confirmLabel="확인" cancelLabel="취소" closeLabel="닫기" onConfirm={() => {}} />
        </>
      );
    }
    render(<H />);
    for (const name of ["row-A", "row-B"]) {
      const opener = screen.getByRole("button", { name });
      await user.click(opener);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(opener).toHaveFocus());
    }
  });

  it("honours onCloseAutoFocus preventDefault (no refocus of the opener)", async () => {
    const user = userEvent.setup();
    function H() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>opener</button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent closeLabel="닫기" onCloseAutoFocus={(e) => e.preventDefault()}>
              <DialogTitle>t</DialogTitle>
              <DialogDescription>d</DialogDescription>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<H />);
    const opener = screen.getByRole("button", { name: "opener" });
    await user.click(opener);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    expect(opener).not.toHaveFocus();
  });
});

describe("FileDropzone focus and drop", () => {
  it("shows a focus indicator on the label when the input is focused", async () => {
    const user = userEvent.setup();
    render(<FileDropzone label="올리기" hint="CSV" fileButtonLabel="파일 선택" folderButtonLabel="폴더 선택" onFiles={() => {}} />);
    await user.tab();
    const input = screen.getByLabelText("파일 선택");
    expect(input).toHaveFocus();
    expect(input).toHaveClass("peer");
    expect(input).toHaveAccessibleDescription("CSV");
    expect(screen.getByText("파일 선택").className).toContain("peer-focus-visible:outline-2");
  });
  it("ignores empty drops", () => {
    const onFiles = vi.fn();
    render(<FileDropzone label="올리기" fileButtonLabel="a" folderButtonLabel="b" onFiles={onFiles} />);
    const group = screen.getByRole("group", { name: "올리기" });
    const ev = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: { files: [] } });
    group.dispatchEvent(ev);
    expect(onFiles).not.toHaveBeenCalled();
  });
});

describe("ErrorState clipboard failure", () => {
  const props = { title: "오류", message: "m", traceId: "t-1", traceIdLabel: "ID", copyLabel: "복사", copiedLabel: "복사됨", copyFailedLabel: "복사 실패" };
  it("announces failure when the clipboard is missing", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<ErrorState {...props} />);
    await user.click(screen.getByRole("button", { name: "복사" }));
    expect(await screen.findByText("복사 실패")).toBeInTheDocument();
    expect(screen.queryByText("복사됨")).not.toBeInTheDocument();
  });
  it("announces failure when writeText rejects", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    render(<ErrorState {...props} />);
    await user.click(screen.getByRole("button", { name: "복사" }));
    expect(await screen.findByText("복사 실패")).toBeInTheDocument();
    expect(screen.queryByText("복사됨")).not.toBeInTheDocument();
  });
});

describe("ErrorState repeated failure", () => {
  it("re-announces when the clipboard is missing and copy is clicked twice", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<ErrorState title="오류" message="m" traceId="t-1" traceIdLabel="ID" copyLabel="복사" copiedLabel="복사됨" copyFailedLabel="복사 실패" />);
    const live = screen.getByText("ID", { exact: false }).parentElement!.querySelector("[aria-live]")!;
    const seen: string[] = [];
    new MutationObserver(() => seen.push(live.textContent ?? "")).observe(live, { childList: true, characterData: true, subtree: true });
    await user.click(screen.getByRole("button", { name: "복사" }));
    await screen.findByText("복사 실패");
    await user.click(screen.getByRole("button", { name: "복사" }));
    await waitFor(() => expect(seen.filter((x) => x === "복사 실패")).toHaveLength(2));
    expect(seen).toContain("");
  });
});

describe("copyText", () => {
  const setExec = (fn: unknown) => Object.defineProperty(document, "execCommand", { value: fn, configurable: true, writable: true });
  it("uses navigator.clipboard when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    expect(await copyText("abc")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("abc");
  });
  it("falls back to a hidden textarea + execCommand('copy') on non-secure origins", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    let copied = "";
    const exec = vi.fn((cmd: string) => {
      copied = (document.activeElement as HTMLTextAreaElement).value;
      return cmd === "copy";
    });
    setExec(exec);
    expect(await copyText("sha-value")).toBe(true);
    expect(copied).toBe("sha-value");
    expect(document.querySelector("textarea")).toBeNull();
  });
  it("falls back when writeText rejects, and reports false when both fail", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    setExec(vi.fn(() => false));
    expect(await copyText("x")).toBe(false);
    setExec(vi.fn(() => true));
    expect(await copyText("x")).toBe(true);
  });
  it("ErrorState copies the trace id through the fallback", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    setExec(vi.fn(() => true));
    render(<ErrorState title="오류" message="m" traceId="t-1" traceIdLabel="ID" copyLabel="복사" copiedLabel="복사됨" copyFailedLabel="복사 실패" />);
    await user.click(screen.getByRole("button", { name: "복사" }));
    expect(await screen.findByText("복사됨")).toBeInTheDocument();
  });
});
