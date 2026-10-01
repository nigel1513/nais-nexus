import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { getDb } from "@/mocks/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { USER, VERSION } from "@/mocks/fixtures";
import { server } from "../../../../tests/msw";
import { renderScreen } from "../../../../tests/render";

const hashFile = vi.hoisted(() => vi.fn(async () => "a".repeat(64)));
const transfer = vi.hoisted(() => vi.fn());
vi.mock("../lib/hash-client", () => ({ hashFile }));
vi.mock("../lib/run-upload", () => ({ transferSession: transfer }));

import { UploadPanel } from "./upload-panel";

const mount = () => renderScreen(<UploadPanel versionId={VERSION.electrolyte} />, { user: USER.aSteward, path: `/commons/data/x/versions/${VERSION.electrolyte}` });
const csv = (name: string, size?: number) => {
  const f = new File(["a,b\n1,2\n"], name, { type: "text/csv" });
  if (size) Object.defineProperty(f, "size", { value: size });
  return f;
};
const pick = async (...files: File[]) => {
  const region = await screen.findByRole("region", { name: "파일 업로드" });
  await userEvent.upload(within(region).getByLabelText("파일 선택"), files);
  return region;
};
const start = (region: HTMLElement) => userEvent.click(within(region).getByRole("button", { name: /업로드 시작|남은 파일 다시 업로드/ }));

beforeEach(() => {
  hashFile.mockClear();
  transfer.mockReset();
  transfer.mockResolvedValue([]);
});

/** complete answers "still verifying": the file stays PENDING server-side until the test (or the worker) settles it. */
const pendingComplete = http.post("*/mock-api/v1/upload-sessions/:id/complete", ({ params }) => {
  const session = { ...getDb().uploadSessions.find((x) => x.upload_session_id === params.id)! } as Record<string, unknown>;
  delete session.created_by;
  return HttpResponse.json(session);
});

const hang = () => {
  let signal: AbortSignal | undefined;
  transfer.mockImplementation(
    (_s: unknown, _p: unknown, deps: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal = deps.signal;
        deps.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
  return () => signal;
};

describe("UploadPanel state machine", () => {
  it("aborts the in-flight transfer on unmount", async () => {
    const signal = hang();
    const { unmount } = mount();
    await start(await pick(csv("a.csv")));
    await waitFor(() => expect(signal()).toBeDefined());
    unmount();
    expect(signal()!.aborted).toBe(true);
  });

  it("cancel aborts, shows no error and lets the file start again without re-hashing", async () => {
    const signal = hang();
    mount();
    const region = await pick(csv("a.csv"));
    await start(region);
    await waitFor(() => expect(signal()).toBeDefined());
    await userEvent.click(within(region).getByRole("button", { name: "업로드 취소" }));
    expect(signal()!.aborted).toBe(true);
    await waitFor(() => expect(within(region).getByRole("button", { name: "업로드 시작" })).toBeEnabled());
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();
    transfer.mockResolvedValue([]);
    await start(region);
    expect(await within(region).findByText("검증됨")).toBeInTheDocument();
    expect(hashFile).toHaveBeenCalledTimes(1);
  });

  it("UPLOAD_SESSION_EXPIRED offers a restart that keeps the hash", async () => {
    server.use(
      http.post(
        "*/mock-api/v1/upload-sessions/:id/complete",
        ({ params }) => {
          getDb().uploadSessions.find((x) => x.upload_session_id === params.id)!.expires_at = new Date(0).toISOString();
          return HttpResponse.json({ error: { code: "UPLOAD_SESSION_EXPIRED", message: "x", details: {}, trace_id: "t" } }, { status: 410 });
        },
        { once: true },
      ),
    );
    mount();
    const region = await pick(csv("a.csv"));
    await start(region);
    expect(await within(region).findByRole("alert")).toBeInTheDocument();
    const restart = within(region).getByRole("button", { name: "남은 파일 다시 업로드" });
    await userEvent.click(restart);
    expect(await within(region).findByText("검증됨")).toBeInTheDocument();
    expect(hashFile).toHaveBeenCalledTimes(1);
  });

  it("an async UPLOADED→FAILED verification shows a localized reason", async () => {
    transfer.mockImplementation(async (session: { files: { file_id: string; upload?: { method: string; parts: { part_number: number }[] } }[] }) =>
      session.files
        .filter((f) => f.upload?.method === "MULTIPART")
        .map((f) => ({ file_id: f.file_id, etags: f.upload!.parts.map((p) => ({ part_number: p.part_number, etag: '"e"' })) })),
    );
    mount();
    const region = await pick(csv("asyncfail.csv", 300 * 1024 ** 2));
    await start(region);
    expect(await within(region).findByText("검증에 실패했습니다. 다시 업로드하세요.", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(within(region).getByText("실패")).toBeInTheDocument();
  });

  it("a PENDING result from complete is updated by polling to VERIFIED", async () => {
    server.use(pendingComplete);
    mount();
    const region = await pick(csv("a.csv"));
    await start(region);
    expect(await within(region).findByText("검증 중")).toBeInTheDocument();
    getDb().versions.find((v) => v.dataset_version_id === VERSION.electrolyte)!.files.forEach((f) => (f.status = "VERIFIED"));
    expect(await within(region).findByText("검증됨", {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("start never re-uploads rows that are still verifying", async () => {
    const bodies: { files: { path: string }[] }[] = [];
    server.use(
      pendingComplete,
      http.get("*/mock-api/v1/dataset-versions/:id", ({ params }) => {
        const v = getDb().versions.find((x) => x.dataset_version_id === params.id)!;
        return HttpResponse.json({ ...v, files: v.files.map((f) => ({ ...f, status: "PENDING" })) });
      }),
      http.post("*/mock-api/v1/dataset-versions/:id/upload-session", async ({ request }) => {
        bodies.push((await request.clone().json()) as { files: { path: string }[] });
        return undefined;
      }),
    );
    mount();
    const region = await pick(csv("a.csv"));
    await start(region);
    await waitFor(() => expect(within(region).getByText("검증 중")).toBeInTheDocument());
    await userEvent.upload(within(region).getByLabelText("파일 선택"), csv("b.csv"));
    await start(region);
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]!.files.map((f) => f.path)).toEqual(["b.csv"]);
  });
});
