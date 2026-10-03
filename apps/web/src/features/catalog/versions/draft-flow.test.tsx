import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { getDb } from "@/mocks/db";
import { DATASET, USER, VERSION } from "@/mocks/fixtures";
import { server } from "../../../../tests/msw";
import { router } from "../../../../tests/navigation";
import { renderScreen } from "../../../../tests/render";
import { VersionDetailScreen } from "../version-detail-screen";
import { useGetFileProfile } from "../api";
import { LATEST_V21, seedStaleDraftWithConflict } from "./test-seeds";

function ProfileProbe({ fileId }: { fileId: string }) {
  const p = useGetFileProfile(fileId);
  return <p data-testid="probe">{p.data && "rows_sampled" in p.data ? String(p.data.rows_sampled) : "…"}</p>;
}

configure({ asyncUtilTimeout: 5000 });

const DS = DATASET.battery;
const open = (versionId: string, user: string = USER.bSteward) =>
  renderScreen(<VersionDetailScreen datasetId={DS} versionId={versionId} readinessPollMs={60_000} />, { user, path: `/commons/data/${DS}/versions/${versionId}` });
const stored = (id: string) => getDb().versions.find((v) => v.dataset_version_id === id);
const banner = async () => screen.findByRole("region", { name: /초안/ });

describe("draft flow", () => {
  it("explains the base when it is the latest", async () => {
    open(VERSION.batteryDraft);
    const b = await banner();
    expect(await within(b).findByText(/최신 버전 기준입니다/)).toBeInTheDocument();
    expect(within(b).getByText(/바뀐 파일만 올리세요/)).toBeInTheDocument();
    expect(within(b).queryByRole("button", { name: "최신 기준으로 갱신" })).toBeNull();
    expect(within(b).getByRole("link", { name: "기준 버전과 비교" })).toHaveAttribute("href", `/commons/data/${DS}/versions/compare?to=${VERSION.batteryDraft}`);
  });

  it("shows the base and offers rebase when stale; conflicts need a choice per path", async () => {
    const { draftId, latestId } = seedStaleDraftWithConflict();
    open(draftId);
    const b = await banner();
    expect(await within(b).findByText("최신 버전(v2.1)이 그 사이 게시됐습니다")).toBeInTheDocument();
    expect(within(b).getByText(/이 초안은 v2\.0 기준입니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "게시" })).toBeDisabled();
    await userEvent.click(within(b).getByRole("button", { name: "최신 기준으로 갱신" }));
    const dialog = await screen.findByRole("dialog", { name: "충돌 해결" });
    expect(within(dialog).getByText("data/measurements.csv")).toBeInTheDocument();
    expect(within(dialog).getByText("c0ffee12")).toBeInTheDocument(); // theirs: short sha
    const apply = within(dialog).getByRole("button", { name: "갱신" });
    expect(apply).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("radio", { name: "내 파일 유지" }));
    expect(apply).toBeEnabled();
    await userEvent.click(apply);
    expect(await within(await banner()).findByText(/최신 버전 기준입니다/)).toBeInTheDocument();
    expect(await screen.findByText("최신 기준으로 갱신했습니다")).toBeInTheDocument();
    const draft = stored(draftId)!;
    expect(draft.base_version_id).toBe(latestId);
    expect(draft.files.find((f) => f.path === "data/measurements.csv")!.inherited_from).toBeUndefined();
  });

  it("taking the latest file makes that path inherited", async () => {
    const { draftId } = seedStaleDraftWithConflict();
    open(draftId);
    await userEvent.click(
      await within(await banner()).findByRole("button", {
        name: "최신 기준으로 갱신",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "충돌 해결" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "최신 버전 파일 사용" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "갱신" }));
    await waitFor(() => expect(stored(draftId)!.files.every((f) => f.inherited_from)).toBe(true));
    expect(await within(screen.getByRole("table")).findAllByText("이어받음")).toHaveLength(5);
  });

  it("publish requires a change note and shows the change summary", async () => {
    open(VERSION.batteryDraft);
    await userEvent.click(await screen.findByRole("button", { name: "게시" }));
    const dialog = await screen.findByRole("dialog", { name: "버전 게시" });
    expect(within(dialog).getByText("추가 0 · 삭제 0 · 변경 1 · 그대로 4")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("v2.0 대비");
    const note = within(dialog).getByLabelText(/^변경 메모/);
    expect(note).toHaveValue("사이클 1001~1200 추가 및 이상 셀(C07) 제외 검토 중"); // prefilled from the draft
    await userEvent.clear(note);
    await userEvent.type(note, "ab");
    await userEvent.click(within(dialog).getByRole("button", { name: "게시" }));
    expect(within(dialog).getByText("변경 메모를 3자 이상 입력하세요")).toBeInTheDocument();
    expect(stored(VERSION.batteryDraft)!.status).toBe("DRAFT");
    await userEvent.clear(note);
    await userEvent.type(note, "이상치 12건 제거");
    await userEvent.click(within(dialog).getByRole("button", { name: "게시" }));
    expect((await screen.findAllByText("게시됨")).length).toBeGreaterThan(0);
    expect(stored(VERSION.batteryDraft)).toMatchObject({
      status: "PUBLISHED",
      change_note: "이상치 12건 제거",
    });
  });

  it("a base that went stale while the dialog was open closes it and shows the stale banner", async () => {
    open(VERSION.batteryDraft);
    await userEvent.click(await screen.findByRole("button", { name: "게시" }));
    const dialog = await screen.findByRole("dialog", { name: "버전 게시" });
    seedStaleDraftWithConflict();
    await userEvent.click(within(dialog).getByRole("button", { name: "게시" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "버전 게시" })).toBeNull());
    expect(await within(await banner()).findByText("최신 버전(v2.1)이 그 사이 게시됐습니다")).toBeInTheDocument();
    expect(stored(VERSION.batteryDraft)!.status).toBe("DRAFT");
  });

  it("inherited files carry a badge; discard asks for confirmation", async () => {
    open(VERSION.batteryDraft);
    expect(await within(await screen.findByRole("table")).findAllByText("이어받음")).toHaveLength(4);
    await userEvent.click(screen.getByRole("button", { name: "초안 삭제" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("v2.1-draft");
    await userEvent.click(within(confirm).getByRole("button", { name: "삭제" }));
    expect(await screen.findByText("초안을 삭제했습니다")).toBeInTheDocument();
    expect(stored(VERSION.batteryDraft)).toBeUndefined();
    expect(router.push).toHaveBeenLastCalledWith(`/commons/data/${DS}?tab=versions`);
  });

  it("an old published version shows a not-latest notice; the latest does not", async () => {
    open(VERSION.batteryV10, USER.aResearcher);
    expect(await screen.findByRole("link", { name: /최신 버전이 아닙니다/ })).toHaveAttribute("href", expect.stringContaining(VERSION.battery));
    expect(screen.getByRole("link", { name: /최신 버전이 아닙니다/ })).toHaveTextContent("v2.0");
  });

  it("the latest published version has no notice and no draft banner", async () => {
    open(VERSION.battery, USER.aResearcher);
    await screen.findByRole("heading", { level: 1, name: "버전 v2.0" });
    await screen.findByRole("region", { name: "AI-Ready 검증" });
    expect(screen.queryByRole("link", { name: /최신 버전이 아닙니다/ })).toBeNull();
    expect(screen.queryByRole("region", { name: /초안/ })).toBeNull();
  });

  it("a THEIRS rebase keeps the row id and refreshes a mounted profile of that file", async () => {
    const { draftId } = seedStaleDraftWithConflict();
    const db = getDb();
    const draft = db.versions.find((v) => v.dataset_version_id === draftId)!;
    const own = draft.files.find((f) => f.path === "data/measurements.csv")!;
    const theirs = db.versions.find((v) => v.dataset_version_id === LATEST_V21)!.files.find((f) => f.path === "data/measurements.csv")!;
    const profile = (rows: number) => ({ status: "READY" as const, column_profile: { format: "csv" as const, rows_sampled: rows, total_rows: rows, truncated: false, columns_truncated: false, columns: [] } });
    db.previews[own.file_id] = profile(1200);
    db.previews[theirs.file_id] = profile(777);
    renderScreen(
      <>
        <VersionDetailScreen datasetId={DS} versionId={draftId} readinessPollMs={60_000} />
        <ProfileProbe fileId={own.file_id} />
      </>,
      { user: USER.bSteward, path: `/commons/data/${DS}/versions/${draftId}` },
    );
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("1200"));
    await userEvent.click(await within(await banner()).findByRole("button", { name: "최신 기준으로 갱신" }));
    const dialog = await screen.findByRole("dialog", { name: "충돌 해결" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "최신 버전 파일 사용" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "갱신" }));
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("777"));
    expect(draft.files.find((f) => f.path === "data/measurements.csv")!.file_id).toBe(own.file_id);
  });

  it("stale with nothing published any more: a plain message, no endless placeholder", async () => {
    seedStaleDraftWithConflict();
    for (const v of getDb().versions) if (v.dataset_id === DS && v.status === "PUBLISHED") v.status = "WITHDRAWN";
    open(VERSION.batteryDraft);
    const b = await banner();
    expect(await within(b).findByText("기준 버전이 더 이상 최신이 아닙니다")).toBeInTheDocument();
    expect(within(b).getByRole("button", { name: "최신 기준으로 갱신" })).toBeInTheDocument();
  });

  it("rebase refused while an upload is open shows the reason", async () => {
    seedStaleDraftWithConflict();
    server.use(
      http.post("*/mock-api/v1/dataset-versions/:version_id/rebase", () =>
        HttpResponse.json(
          {
            error: {
              code: "CONFLICT",
              message: "x",
              details: {},
              trace_id: "t",
            },
          },
          { status: 409 },
        ),
      ),
    );
    open(VERSION.batteryDraft);
    await userEvent.click(
      await within(await banner()).findByRole("button", {
        name: "최신 기준으로 갱신",
      }),
    );
    expect(await screen.findByText(/진행 중인 업로드를 마치거나 취소한 뒤/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "충돌 해결" })).toBeNull();
  });
  it("a second conflict set gets fresh choices, and only its paths are sent", async () => {
    seedStaleDraftWithConflict();
    const side = { size_bytes: 10, sha256: "a".repeat(64) };
    const conflict = (path: string) => ({ path, base: side, mine: side, theirs: { ...side, sha256: "b".repeat(64) } });
    const bodies: unknown[] = [];
    server.use(
      http.post("*/mock-api/v1/dataset-versions/:version_id/rebase", async ({ request }) => {
        bodies.push(await request.json());
        const conflicts = bodies.length === 1 ? [conflict("data/a.csv")] : bodies.length === 2 ? [conflict("data/b.csv")] : null;
        return HttpResponse.json({ error: { code: conflicts ? "CONFLICT" : "INTERNAL_ERROR", message: "x", details: conflicts ? { conflicts } : {}, trace_id: "t" } }, { status: conflicts ? 409 : 500 });
      }),
    );
    open(VERSION.batteryDraft);
    await userEvent.click(await within(await banner()).findByRole("button", { name: "최신 기준으로 갱신" }));
    let dialog = await screen.findByRole("dialog", { name: "충돌 해결" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "내 파일 유지" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "갱신" }));
    dialog = await screen.findByRole("dialog", { name: "충돌 해결" });
    expect(await within(dialog).findByText("data/b.csv")).toBeInTheDocument();
    expect(within(dialog).queryByText("data/a.csv")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "갱신" })).toBeDisabled(); // no choice carried over
    await userEvent.click(within(dialog).getByRole("radio", { name: "최신 버전 파일 사용" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "갱신" }));
    await waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies[1]).toEqual({ resolutions: { "data/a.csv": "MINE" } });
    expect(bodies[2]).toEqual({ resolutions: { "data/b.csv": "THEIRS" } });
  });

  it("holds the stale sentences until the latest version label is known", async () => {
    seedStaleDraftWithConflict();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get("*/mock-api/v1/datasets/:dataset_id/versions", async () => {
        await gate;
        return undefined; // fall through to the mock handler
      }),
    );
    open(VERSION.batteryDraft);
    const b = await banner();
    expect(within(b).getByRole("button", { name: "최신 기준으로 갱신" })).toBeInTheDocument();
    expect(within(b).queryByText(/그 사이 게시됐습니다/)).toBeNull();
    release();
    expect(await within(b).findByText("최신 버전(v2.1)이 그 사이 게시됐습니다")).toBeInTheDocument();
  });

  it("a publish refusal other than a stale base is shown once, inline", async () => {
    server.use(
      http.post("*/mock-api/v1/dataset-versions/:version_id/publish", () =>
        HttpResponse.json({ error: { code: "DATASET_VERSION_INCOMPLETE", message: "x", details: { files: [{ file_id: "f9", path: "late/part.csv", status: "UPLOADED" }] }, trace_id: "t" } }, { status: 409 }),
      ),
    );
    open(VERSION.batteryDraft);
    await userEvent.click(await screen.findByRole("button", { name: "게시" }));
    const dialog = await screen.findByRole("dialog", { name: "버전 게시" });
    expect(dialog).toHaveTextContent("게시 후에는 버전 이름을 바꿀 수 없습니다.");
    expect(dialog).not.toHaveTextContent("v3.0");
    await userEvent.click(within(dialog).getByRole("button", { name: "게시" }));
    const item = await screen.findByText("late/part.csv");
    const message = item.closest('[role="alert"]')!.querySelector("p")!.textContent!;
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getAllByText(message)).toHaveLength(1);
  });
});

