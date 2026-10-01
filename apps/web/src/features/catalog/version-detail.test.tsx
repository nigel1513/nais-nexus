import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/mocks/db";
import { DATASET, GRANT, USER, VERSION } from "@/mocks/fixtures";
import { server } from "../../../tests/msw";
import { renderScreen } from "../../../tests/render";
import { VersionDetailScreen } from "./version-detail-screen";

const open = (user: string, datasetId: string, versionId: string) =>
  renderScreen(<VersionDetailScreen datasetId={datasetId} versionId={versionId} readinessPollMs={30} />, {
    user,
    path: `/commons/data/${datasetId}/versions/${versionId}`,
  });

describe("VersionDetailScreen", () => {
  it("shows header, file manifest and readiness checks of a published version", async () => {
    open(USER.bSteward, DATASET.battery, VERSION.battery);
    expect(await screen.findByRole("heading", { level: 1, name: "버전 v2.0" })).toBeInTheDocument();
    expect(screen.getAllByText("게시됨").length).toBeGreaterThan(0);
    expect(screen.getAllByText("data/measurements.csv").length).toBeGreaterThan(0);
    const readiness = screen.getByRole("region", { name: "AI-Ready 검증" });
    expect((await within(readiness).findAllByRole("heading", { level: 3, name: /TABULAR_ML_BASIC/ })).length).toBeGreaterThan(0);
    expect(within(readiness).getAllByText("통과").length).toBeGreaterThan(0);
    expect(screen.queryByRole("region", { name: "파일 업로드" })).not.toBeInTheDocument();
  });

  it("steward uploads (with path auto-convert), publishes, and readiness completes by polling", async () => {
    open(USER.aSteward, DATASET.electrolyte, VERSION.electrolyte);
    const upload = await screen.findByRole("region", { name: "파일 업로드" });
    const file = new File(["a,b\n1,2\n"], "데이터 1.csv", { type: "text/csv" });
    await userEvent.upload(within(upload).getByLabelText("파일 선택"), file);
    expect(await within(upload).findByText(/영문, 숫자/)).toBeInTheDocument();
    expect(within(upload).getByRole("button", { name: "업로드 시작" })).toBeDisabled();
    await userEvent.click(within(upload).getByRole("button", { name: "모두 자동 변환" }));
    expect(within(upload).getByText("1.csv")).toBeInTheDocument();
    await userEvent.click(within(upload).getByRole("button", { name: "업로드 시작" }));
    expect(await within(upload).findByText("검증됨", {}, { timeout: 5000 })).toBeInTheDocument();

    const publish = await screen.findByRole("button", { name: "게시" });
    await waitFor(() => expect(publish).toBeEnabled());
    await userEvent.click(publish);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("게시 후에는 수정할 수 없습니다");
    await userEvent.click(within(dialog).getByRole("button", { name: "게시" }));
    const readiness = screen.getByRole("region", { name: "AI-Ready 검증" });
    await waitFor(() => expect(within(readiness).getAllByText("완료").length).toBeGreaterThan(0), { timeout: 5000 });
    expect(getDb().versions.find((v) => v.dataset_version_id === VERSION.electrolyte)?.status).toBe("PUBLISHED");
  });

  it("grant holder gets per-file links with a countdown and sha256", async () => {
    open(USER.aResearcher, DATASET.battery, VERSION.battery);
    const panel = await screen.findByRole("region", { name: "다운로드" });
    const request = within(panel).getByRole("button", { name: "다운로드 링크 받기" });
    await waitFor(() => expect(request).toBeEnabled()); // the single grant project is pre-selected once projects load
    await userEvent.click(request);
    const links = await within(panel).findAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["README.md", "_codebook.csv", "_schema.json", "data/measurements.csv", "data/test_cells.csv"]);
    expect(links[0]).toHaveAttribute("download");
    expect(within(panel).getByText(/링크 만료까지 \d:\d\d/)).toBeInTheDocument();
  });

  it("revoked grant: shows the message and never renders a URL (M10-AT-07)", async () => {
    const grant = getDb().grants.find((g) => g.access_grant_id === GRANT.seed)!;
    Object.assign(grant, { status: "REVOKED", revoked_at: new Date().toISOString(), revocation_reason: "종료" });
    open(USER.aResearcher, DATASET.battery, VERSION.battery);
    const panel = await screen.findByRole("region", { name: "다운로드" });
    const request = await within(panel).findByRole("button", { name: "다운로드 링크 받기" });
    await waitFor(() => expect(request).toBeEnabled());
    await userEvent.click(request);
    expect(await within(panel).findByRole("alert")).toHaveTextContent("접근 권한이 회수되었습니다.");
    expect(within(panel).queryAllByRole("link")).toHaveLength(0);
    expect(panel.innerHTML).not.toContain("/mock-storage/");
  });

  it("expired links are disabled and can be re-requested (WCAG 2.2.1)", async () => {
    server.use(
      http.post("*/mock-api/v1/dataset-versions/:version_id/download-session", () =>
        HttpResponse.json(
          {
            dataset_version_id: VERSION.openMaterials,
            basis: "PUBLIC",
            access_grant_id: null,
            expires_at: new Date(Date.now() + 1000).toISOString(),
            files: [
              { file_id: "f1", path: "a.csv", url: "http://localhost:3000/mock-storage/x/a.csv", size_bytes: 1, sha256: "a".repeat(64) },
              { file_id: "f2", path: "b.csv", url: "http://localhost:3000/mock-storage/x/b.csv", size_bytes: 1, sha256: "b".repeat(64) },
            ],
          },
          { status: 201 },
        ),
      ),
    );
    open(USER.aResearcher, DATASET.openMaterials, VERSION.openMaterials);
    const panel = await screen.findByRole("region", { name: "다운로드" });
    await userEvent.click(within(panel).getByRole("button", { name: "다운로드 링크 받기" }));
    expect(await within(panel).findAllByRole("link")).toHaveLength(2);
    expect(await within(panel).findByRole("button", { name: "링크 다시 받기" }, { timeout: 3000 })).toBeInTheDocument();
    expect(within(panel).queryAllByRole("link")).toHaveLength(0);
  });

  it("publish refusal lists the files that are not VERIFIED (DATASET_VERSION_INCOMPLETE)", async () => {
    const v = getDb().versions.find((x) => x.dataset_version_id === VERSION.electrolyte)!;
    v.files.push({ file_id: "f-ok", path: "ok.csv", size_bytes: 3, sha256: "a".repeat(64), media_type: "text/csv", status: "VERIFIED", failure_code: null } as (typeof v.files)[number]);
    server.use(
      http.post("*/mock-api/v1/dataset-versions/:version_id/publish", () =>
        HttpResponse.json(
          { error: { code: "DATASET_VERSION_INCOMPLETE", message: "x", details: { files: [{ file_id: "f9", path: "late/part.csv", status: "UPLOADED" }] }, trace_id: "t" } },
          { status: 409 },
        ),
      ),
    );
    open(USER.aSteward, DATASET.electrolyte, VERSION.electrolyte);
    const publish = await screen.findByRole("button", { name: "게시" });
    await waitFor(() => expect(publish).toBeEnabled());
    await userEvent.click(publish);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "게시" }));
    const alert = await screen.findByText("late/part.csv");
    expect(alert.closest('[role="alert"]')).toHaveTextContent("검증");
  });

  it("renders the per-file size limit in upload messages ({max})", async () => {
    server.use(
      http.post("*/mock-api/v1/dataset-versions/:version_id/upload-session", () =>
        HttpResponse.json({ error: { code: "FILE_TOO_LARGE", message: "x", details: {}, trace_id: "t" } }, { status: 422 }),
      ),
    );
    open(USER.aSteward, DATASET.electrolyte, VERSION.electrolyte);
    const upload = await screen.findByRole("region", { name: "파일 업로드" });
    expect(upload).toHaveTextContent(/파일당 최대 50(\.0)? GiB/);
    await userEvent.upload(within(upload).getByLabelText("파일 선택"), new File(["a,b\n"], "big.csv", { type: "text/csv" }));
    await userEvent.click(within(upload).getByRole("button", { name: "업로드 시작" }));
    expect(await within(upload).findByText(/최대 크기\(50(\.0)? GiB\)/)).toBeInTheDocument();
  });

  it("grants spanning several projects require choosing the project before downloading", async () => {
    const seed = getDb().grants.find((g) => g.access_grant_id === GRANT.seed)!;
    getDb().grants.push({ ...seed, access_grant_id: "00000000-0000-7000-8000-000000004002", project_id: "00000000-0000-7000-8000-000000001099", project_name: "Second Study" });
    open(USER.aResearcher, DATASET.battery, VERSION.battery);
    const panel = await screen.findByRole("region", { name: "다운로드" });
    const choose = await within(panel).findByLabelText("이용 프로젝트");
    const request = within(panel).getByRole("button", { name: "다운로드 링크 받기" });
    expect(request).toBeDisabled();
    expect(within(choose).getAllByRole("option")).toHaveLength(3);
    await userEvent.selectOptions(choose, within(choose).getByRole("option", { name: /Seed/ }));
    expect(request).toBeEnabled();
  });

  const addFile = (status: "VERIFIED" | "PENDING", path = "ok.csv") => {
    const v = getDb().versions.find((x) => x.dataset_version_id === VERSION.electrolyte)!;
    v.files.push({ file_id: "00000000-0000-7000-8000-0000000f0001", path, size_bytes: 3, sha256: "a".repeat(64), media_type: "text/csv", status } as (typeof v.files)[number]);
  };

  it("deleting a draft file asks for confirmation naming the path", async () => {
    addFile("VERIFIED");
    open(USER.aSteward, DATASET.electrolyte, VERSION.electrolyte);
    await userEvent.click((await screen.findAllByRole("button", { name: "ok.csv 삭제" }))[0]!);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("ok.csv");
    await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(getDb().versions.find((v) => v.dataset_version_id === VERSION.electrolyte)!.files).toHaveLength(1);
    await userEvent.click(screen.getAllByRole("button", { name: "ok.csv 삭제" })[0]!);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(getDb().versions.find((v) => v.dataset_version_id === VERSION.electrolyte)!.files).toHaveLength(0));
  });

  it("delete conflict (409 CONFLICT) shows the localized error", async () => {
    addFile("VERIFIED");
    server.use(
      http.delete("*/mock-api/v1/dataset-versions/:version_id/files/:file_id", () =>
        HttpResponse.json({ error: { code: "CONFLICT", message: "x", details: {}, trace_id: "t" } }, { status: 409 }),
      ),
    );
    open(USER.aSteward, DATASET.electrolyte, VERSION.electrolyte);
    await userEvent.click((await screen.findAllByRole("button", { name: "ok.csv 삭제" }))[0]!);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "삭제" }));
    expect(await screen.findByText("다른 변경과 충돌했습니다. 새로고침 후 다시 시도하세요.")).toBeInTheDocument();
  });

  it("publish stays disabled while a file is not VERIFIED", async () => {
    addFile("PENDING");
    open(USER.aSteward, DATASET.electrolyte, VERSION.electrolyte);
    expect(await screen.findByRole("button", { name: "게시" })).toBeDisabled();
  });

  it("a non-steward sees no publish, upload or readiness start", async () => {
    open(USER.aResearcher, DATASET.battery, VERSION.battery);
    await screen.findByRole("heading", { level: 1, name: "버전 v2.0" });
    await screen.findByRole("region", { name: "AI-Ready 검증" });
    expect(screen.queryByRole("button", { name: "게시" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "파일 업로드" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "검증 실행" })).not.toBeInTheDocument();
  });

  it("readiness start refusal (409) is reported and the default profile is the first loaded one", async () => {
    server.use(
      http.post("*/mock-api/v1/dataset-versions/:version_id/readiness-validations", () =>
        HttpResponse.json({ error: { code: "READINESS_VALIDATION_IN_PROGRESS", message: "x", details: {}, trace_id: "t" } }, { status: 409 }),
      ),
    );
    open(USER.bSteward, DATASET.battery, VERSION.battery);
    const readiness = await screen.findByRole("region", { name: "AI-Ready 검증" });
    const select = await within(readiness).findByLabelText("검증 프로파일");
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBeGreaterThan(0));
    expect((select as HTMLSelectElement).value).toBe((within(select).getAllByRole("option")[0] as HTMLOptionElement).value);
    await userEvent.click(within(readiness).getByRole("button", { name: "검증 실행" }));
    expect(await screen.findByText("이미 검증이 진행 중입니다.")).toBeInTheDocument();
  });

  it("localizes a failed readiness run by its code prefix", async () => {
    const run = getDb().validations[0]!;
    Object.assign(run, { run_status: "FAILED", error: "FILE_TIMEOUT: parsing exceeded 600s", overall_status: null, checks: [] });
    open(USER.bSteward, DATASET.battery, VERSION.battery);
    const readiness = await screen.findByRole("region", { name: "AI-Ready 검증" });
    expect(await within(readiness).findAllByText("파일 분석 시간이 초과되었습니다.")).not.toHaveLength(0);
    expect(readiness).not.toHaveTextContent("parsing exceeded");
  });

  it("copy-SHA buttons are named per file and report clipboard rejection", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) }, configurable: true });
    open(USER.bSteward, DATASET.battery, VERSION.battery);
    const buttons = await screen.findAllByRole("button", { name: "data/measurements.csv SHA-256 복사" });
    await userEvent.click(buttons[0]!);
    expect(await screen.findByText("복사하지 못했습니다. 직접 선택해 복사해 주세요.")).toBeInTheDocument();
  });

  it("copy-SHA works on a non-secure origin through the execCommand fallback", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => true), configurable: true, writable: true });
    open(USER.bSteward, DATASET.battery, VERSION.battery);
    const buttons = await screen.findAllByRole("button", { name: "data/measurements.csv SHA-256 복사" });
    await userEvent.click(buttons[0]!);
    expect(await screen.findByText("SHA-256을 복사했습니다.")).toBeInTheDocument();
  });

  it("when every copy path fails the full SHA-256 is shown selectable", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => false), configurable: true, writable: true });
    open(USER.bSteward, DATASET.battery, VERSION.battery);
    const buttons = await screen.findAllByRole("button", { name: "data/measurements.csv SHA-256 복사" });
    await userEvent.click(buttons[0]!);
    const full = getDb().versions.find((v) => v.dataset_version_id === VERSION.battery)!.files.find((f) => f.path === "data/measurements.csv")!.sha256;
    expect(await screen.findByText(full)).toBeInTheDocument();
  });
});
