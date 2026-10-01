import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog, DataTable, ErrorState, FileDropzone, FormField, Input, StatusBadge } from "./index";

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
    expect(trigger).toHaveFocus();
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
