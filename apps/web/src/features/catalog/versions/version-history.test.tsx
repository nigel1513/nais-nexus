import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { getDb } from "@/mocks/db";
import { DATASET, USER, VERSION } from "@/mocks/fixtures";
import { server } from "../../../../tests/msw";
import { router } from "../../../../tests/navigation";
import { renderScreen } from "../../../../tests/render";
import { useGetDataset } from "../api";
import { VersionHistoryTab } from "./version-history-tab";

configure({ asyncUtilTimeout: 5000 });

function Tab({ datasetId }: { datasetId: string }) {
  const ds = useGetDataset(datasetId);
  return ds.data ? <VersionHistoryTab dataset={ds.data} /> : null;
}

const open = (user: string, datasetId: string = DATASET.battery) =>
  renderScreen(<Tab datasetId={datasetId} />, { user, path: `/commons/data/${datasetId}?tab=versions` });

const history = async () => within(await screen.findByRole("list", { name: "게시 이력" }));

describe("VersionHistoryTab", () => {
  it("shows a commit-list history with change summaries, lineage and per-row download", async () => {
    open(USER.bSteward);
    const rows = (await history()).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("aria-label")?.split(" ")[0])).toEqual(["v2.0", "v1.1", "v1.0"]);
    const latest = rows[0]!;
    // v1.1 -> v2.0: _codebook.csv and _schema.json added; README and measurements changed; test_cells identical.
    expect(within(latest).getByText("+2")).toBeInTheDocument();
    expect(within(latest).getByText("−0")).toBeInTheDocument();
    expect(within(latest).getByText("~2")).toBeInTheDocument();
    expect(within(latest).getByText("사이클 501~1000 추가, 컬럼 정의(_codebook.csv)와 스키마(_schema.json) 정비, 셀 정보 파일 포함")).toBeInTheDocument();
    expect(within(latest).getByText("정현우")).toBeInTheDocument();
    expect(within(latest).getByText("v1.1")).toBeInTheDocument(); // previous version in the lineage line
    expect(within(latest).getByRole("link", { name: "v2.0" })).toHaveAttribute("href", `/commons/data/${DATASET.battery}/versions/${VERSION.battery}`);
    expect(within(latest).getByRole("link", { name: "다운로드" })).toHaveAttribute("href", expect.stringContaining("?download=1"));
    expect(within(latest).getByRole("link", { name: "비교" })).toHaveAttribute("href", `/commons/data/${DATASET.battery}/versions/compare?to=${VERSION.battery}`);
    expect(within(latest).getByRole("button", { name: "이 버전에서 새 초안" })).toBeInTheDocument();
    expect(within(latest).queryByRole("button", { name: "이 버전으로 되돌리기" })).toBeNull();
    expect(within(rows[2]!).getByRole("button", { name: "이 버전으로 되돌리기" })).toBeInTheDocument();
    // The steward's open draft sits above the history, with its base version.
    const drafts = within(screen.getByRole("list", { name: "작업 중인 초안" }));
    const draft = drafts.getByRole("listitem");
    expect(draft).toHaveAccessibleName(/^v2\.1-draft /);
    expect(within(draft).getByText("초안")).toBeInTheDocument();
    expect(within(draft).queryByRole("link", { name: "다운로드" })).toBeNull();
  });

  it("creates a draft from the latest with a suggested label and reports the inherited files", async () => {
    open(USER.bSteward);
    await userEvent.click(await screen.findByRole("button", { name: "새 초안" }));
    const dialog = await screen.findByRole("dialog", { name: "새 초안" });
    await userEvent.click(within(dialog).getByRole("button", { name: "v2.1 (작은 수정)" }));
    expect(within(dialog).getByLabelText(/^버전 이름/)).toHaveValue("v2.1");
    expect(within(dialog).getByRole("radio", { name: "최신 버전 파일 이어받기 (권장)" })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "초안 만들기" }));
    expect(await screen.findByText("파일 5개를 이어받았습니다")).toBeInTheDocument();
    const created = getDb().versions.find((v) => v.dataset_id === DATASET.battery && v.version_label === "v2.1")!;
    expect(created.status).toBe("DRAFT");
    expect(router.push).toHaveBeenLastCalledWith(`/commons/data/${DATASET.battery}/versions/${created.dataset_version_id}`);
  });

  it("starts an empty draft when asked", async () => {
    let body: unknown;
    server.use(
      http.post("*/mock-api/v1/datasets/:dataset_id/versions", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ error: { code: "CONFLICT", message: "x", trace_id: "t" } }, { status: 409 });
      }),
    );
    open(USER.bSteward);
    await userEvent.click(await screen.findByRole("button", { name: "새 초안" }));
    const dialog = await screen.findByRole("dialog", { name: "새 초안" });
    await userEvent.click(within(dialog).getByRole("button", { name: "v3.0 (큰 변경)" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: "빈 초안" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "초안 만들기" }));
    await waitFor(() => expect(body).toEqual({ version_label: "v3.0", empty: true }));
    expect(screen.getByRole("dialog")).toBeInTheDocument(); // the error keeps it open
  });

  it("rejects a malformed label without calling the server", async () => {
    open(USER.bSteward);
    await userEvent.click(await screen.findByRole("button", { name: "새 초안" }));
    const dialog = await screen.findByRole("dialog", { name: "새 초안" });
    await userEvent.type(within(dialog).getByLabelText(/^버전 이름/), "v 2");
    await userEvent.click(within(dialog).getByRole("button", { name: "초안 만들기" }));
    expect(await within(dialog).findByText("버전 이름은 영문, 숫자, . _ - 로 32자 이하입니다.")).toBeInTheDocument();
    expect(getDb().versions.filter((v) => v.dataset_id === DATASET.battery)).toHaveLength(4);
  });

  it("reverts to an old version as a new draft", async () => {
    open(USER.bSteward);
    const v10 = (await history()).getByRole("listitem", { name: /^v1\.0 / });
    await userEvent.click(within(v10).getByRole("button", { name: "이 버전으로 되돌리기" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("v1.0의 파일로 새 초안을 만듭니다");
    expect(within(dialog).queryByRole("radio")).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "v2.1 (작은 수정)" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "초안 만들기" }));
    expect(await screen.findByText("파일 2개를 이어받았습니다")).toBeInTheDocument();
    const created = getDb().versions.find((v) => v.dataset_id === DATASET.battery && v.version_label === "v2.1")!;
    expect(created.source_version_id).toBe(VERSION.batteryV10);
  });

  it("hides steward actions and drafts from other organizations", async () => {
    open(USER.aResearcher);
    expect((await history()).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "새 초안" })).toBeNull();
    expect(screen.queryByRole("button", { name: /되돌리기|새 초안/ })).toBeNull();
    expect(screen.queryByText("초안")).toBeNull();
    expect(screen.queryByRole("list", { name: "작업 중인 초안" })).toBeNull();
  });

  it("offers 비교 only where a previous version exists, and 다운로드 only to viewers who can download", async () => {
    open(USER.bSteward);
    const v10 = (await history()).getByRole("listitem", { name: /^v1\.0 / });
    expect(within(v10).queryByRole("link", { name: "비교" })).toBeNull();
    expect(within(v10).getByText("첫 버전")).toBeInTheDocument();
    expect(within(v10).getByRole("link", { name: "다운로드" })).toBeInTheDocument();
  });

  it("a viewer with neither grant nor steward role sees no download links", async () => {
    open(USER.bResearcher);
    const rows = (await history()).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByRole("link", { name: "비교" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("link", { name: "다운로드" })).toBeNull());
  });

  it("hides 비교 when the row has no visible comparison target (null change_summary, ruling S10)", async () => {
    getDb().versions.find((v) => v.dataset_version_id === VERSION.batteryV11)!.status = "WITHDRAWN";
    open(USER.aResearcher);
    const rows = (await history()).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("aria-label")?.split(" ")[0])).toEqual(["v2.0", "v1.0"]); // withdrawn v1.1 is not listed
    expect(within(rows[0]!).queryByRole("link", { name: "비교" })).toBeNull();
  });

  it("a grant holder sees download links", async () => {
    open(USER.aResearcher);
    expect(await within((await history()).getAllByRole("listitem")[0]!).findByRole("link", { name: "다운로드" })).toBeInTheDocument();
  });

  it("explains the label rule in a popover", async () => {
    open(USER.bSteward);
    await userEvent.click(await screen.findByRole("button", { name: "버전 이름 규칙" }));
    expect(await screen.findByText(/둘째 자리를 올립니다/)).toBeInTheDocument();
  });
});
