import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DATASET, PROJECT, USER, VERSION } from "@/mocks/fixtures";
import { makeQueryClient } from "@/shared/api/query-client";
import { server } from "../../tests/msw";
import { setMockUser } from "../../tests/render";
import { useCreateDatasetVersion, useGetDatasetVersion, usePublishDatasetVersion, useSearchDatasets } from "./catalog/api";
import { useApproveAccessRequest, useCreateAccessRequest, useListAccessRequests, useStartAccessReview } from "./governance/api";
import { useCreateProject, useGetProject, useListProjects } from "./projects/api";
import { useDeleteDraftFile } from "./upload/api";
import { useGetReadiness } from "./readiness/api";

const ready = vi.hoisted(() => ({ value: true }));
vi.mock("@/features/auth/use-auth-ready", () => ({ useAuthReady: () => ready.value }));

function wrapper(client = makeQueryClient({ retry: false })) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

describe("domain hooks", () => {
  it("createProject invalidates listProjects", async () => {
    setMockUser(USER.aResearcher);
    const { result } = renderHook(() => ({ list: useListProjects({ scope: "mine" }), create: useCreateProject() }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.list.data?.pages[0]?.items).toHaveLength(1));
    await act(() => result.current.create.mutateAsync({ name: "Hook Study", description: "" }));
    await waitFor(() => expect(result.current.list.data?.pages[0]?.items).toHaveLength(2));
  });

  it("createAccessRequest invalidates listAccessRequests", async () => {
    setMockUser(USER.aResearcher);
    const { result } = renderHook(
      () => ({ list: useListAccessRequests({ role: "requester" }), create: useCreateAccessRequest(), project: useCreateProject() }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    const before = result.current.list.data!.pages[0]!.items.length;
    const p = await act(() => result.current.project.mutateAsync({ name: "Req Study", description: "" }));
    await act(() =>
      result.current.create.mutateAsync({
        dataset_id: DATASET.battery,
        project_id: p.project_id,
        purpose: "ACADEMIC_RESEARCH",
        purpose_detail: "훅 테스트를 위한 충분히 긴 이용 목적 상세 설명입니다.",
        operations: ["READ"],
        requested_days: 30,
      }),
    );
    await waitFor(() => expect(result.current.list.data!.pages[0]!.items.length).toBe(before + 1));
  });

  it("searchDatasets keeps the previous results while a new query loads", async () => {
    setMockUser(USER.aResearcher);
    const { result, rerender } = renderHook(({ q }: { q: string }) => useSearchDatasets({ q }), { wrapper: wrapper(), initialProps: { q: "배터리" } });
    await waitFor(() => expect(result.current.data?.pages[0]?.items).toHaveLength(1));
    server.use(http.get("*/mock-api/v1/datasets", async () => { await delay(150); return undefined; }));
    rerender({ q: "센서" });
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.pages[0]?.items[0]?.title).toBe("리튬이온 배터리 셀 사이클 시험 데이터");
    await waitFor(() => expect(result.current.data?.pages[0]?.items[0]?.title).toBe("시험동 공조 설비 센서 스트림"));
  });

  it("getReadiness polls while runs are pending and stops when completed", async () => {
    setMockUser(USER.aSteward);
    const { result } = renderHook(() => useGetReadiness(VERSION.sensors), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.items.every((v) => v.run_status === "COMPLETED")).toBe(true);
  });

  it("getReadiness reaches COMPLETED by polling after a new run is queued", async () => {
    setMockUser(USER.aSteward);
    // electrolyte v1 is a DRAFT (readiness 404s for drafts, M05 §6.3); simulate "just published, runs not queued yet".
    const { getDb } = await import("@/mocks/db");
    const { queueValidation } = await import("@/mocks/handlers/catalog");
    getDb().versions.find((v) => v.dataset_version_id === VERSION.electrolyte)!.status = "PUBLISHED";
    const { result } = renderHook(() => useGetReadiness(VERSION.electrolyte, { intervalMs: 30 }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items).toHaveLength(0);
    queueValidation(getDb(), VERSION.electrolyte, "GENERIC_BASIC", "USER");
    await waitFor(() => expect(result.current.data?.items[0]?.run_status).toBe("COMPLETED"), { timeout: 3000 });
  });

  it("surfaces ApiError from hooks (non-member opening a PRIVATE project)", async () => {
    setMockUser(USER.aSteward);
    const { result } = renderHook(() => useGetProject(PROJECT.seed), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("maps mutation failures to ApiError", async () => {
    setMockUser(USER.aResearcher);
    const { result } = renderHook(() => useCreateProject(), { wrapper: wrapper() });
    await act(async () => {
      await result.current.mutateAsync({ name: "", description: "" }).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("does not fetch until auth is ready", async () => {
    setMockUser(USER.aResearcher);
    let calls = 0;
    server.use(http.get("*/mock-api/v1/projects/:id", () => { calls++; return undefined; }));
    ready.value = false;
    const { result, rerender } = renderHook(() => useGetProject(PROJECT.seed), { wrapper: wrapper() });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(0);
    expect(result.current.fetchStatus).toBe("idle");
    ready.value = true;
    rerender();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls).toBe(1);
  });
});

const keys = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
const readinessUrl = "*/mock-api/v1/dataset-versions/:id/readiness";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("readiness polling", () => {
  function countRequests(url = readinessUrl) {
    const n = { calls: 0 };
    server.use(http.get(url, () => { n.calls++; return undefined; }));
    return n;
  }

  it("stops after COMPLETED", async () => {
    setMockUser(USER.aSteward);
    const n = countRequests();
    const { result } = renderHook(() => useGetReadiness(VERSION.sensors, { intervalMs: 20 }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await wait(200);
    expect(n.calls).toBe(1);
  });

  it("follows RUNNING to COMPLETED and then stops", async () => {
    setMockUser(USER.aSteward);
    const { getDb } = await import("@/mocks/db");
    const { queueValidation } = await import("@/mocks/handlers/catalog");
    getDb().versions.find((v) => v.dataset_version_id === VERSION.electrolyte)!.status = "PUBLISHED";
    queueValidation(getDb(), VERSION.electrolyte, "GENERIC_BASIC", "USER");
    const n = countRequests();
    const seen: string[] = [];
    const { result } = renderHook(
      () => {
        const q = useGetReadiness(VERSION.electrolyte, { intervalMs: 20 });
        const st = q.data?.items[0]?.run_status;
        if (st && seen.at(-1) !== st) seen.push(st);
        return q;
      },
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data?.items[0]?.run_status).toBe("COMPLETED"));
    expect(seen).toEqual(["RUNNING", "COMPLETED"]);
    const done = n.calls;
    await wait(200);
    expect(n.calls).toBe(done);
  });

  it("stops on unmount", async () => {
    setMockUser(USER.aSteward);
    const { getDb } = await import("@/mocks/db");
    getDb().versions.find((v) => v.dataset_version_id === VERSION.electrolyte)!.status = "PUBLISHED";
    const n = countRequests();
    const { unmount } = renderHook(() => useGetReadiness(VERSION.electrolyte, { intervalMs: 20 }), { wrapper: wrapper() });
    await waitFor(() => expect(n.calls).toBeGreaterThan(1)); // empty runs keep polling
    unmount();
    await wait(50);
    const after = n.calls;
    await wait(200);
    expect(n.calls).toBe(after);
  });

  it("stops on 404/403 errors", async () => {
    setMockUser(USER.aSteward);
    const n = countRequests();
    const { result } = renderHook(() => useGetReadiness(VERSION.electrolyte, { intervalMs: 20 }), { wrapper: wrapper() }); // DRAFT -> 404
    await waitFor(() => expect(result.current.isError).toBe(true));
    await wait(200);
    expect(n.calls).toBe(1);
    const n2 = { calls: 0 };
    server.use(http.get(readinessUrl, () => { n2.calls++; return HttpResponse.json({ error: { code: "FORBIDDEN", message: "x", trace_id: "t" } }, { status: 403 }); }));
    const r2 = renderHook(() => useGetReadiness(VERSION.sensors, { intervalMs: 20 }), { wrapper: wrapper() });
    await waitFor(() => expect(r2.result.current.isError).toBe(true));
    await wait(150);
    expect(n2.calls).toBe(1);
  });

  it("backs off while a published version keeps returning no runs", async () => {
    setMockUser(USER.aSteward);
    const n = { calls: 0 };
    server.use(http.get(readinessUrl, () => { n.calls++; return HttpResponse.json({ items: [] }); }));
    renderHook(() => useGetReadiness(VERSION.sensors, { intervalMs: 5 }), { wrapper: wrapper() });
    await wait(300);
    expect(n.calls).toBeLessThanOrEqual(5); // 4 quick polls, then 30 s back-off
  });
});

describe("version detail polling", () => {
  const versionUrl = "*/mock-api/v1/dataset-versions/:id";
  const serve = (status: string) => {
    const n = { calls: 0 };
    server.use(
      http.get(versionUrl, async ({ params }) => {
        n.calls++;
        const { getDb } = await import("@/mocks/db");
        const v = getDb().versions.find((x) => x.dataset_version_id === params.id)!;
        return HttpResponse.json({ ...v, files: [{ file_id: "00000000-0000-7000-8000-0000000f0001", path: "a.csv", size_bytes: 3, sha256: "a".repeat(64), media_type: "text/csv", status }] });
      }),
    );
    return n;
  };

  it("does not poll forever for PENDING rows nobody is uploading", async () => {
    setMockUser(USER.aSteward);
    const n = serve("PENDING");
    const { result } = renderHook(() => useGetDatasetVersion(VERSION.electrolyte, { pollMs: 20 }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await wait(200);
    expect(n.calls).toBe(1);
  });

  it("polls PENDING rows while a local upload is in progress", async () => {
    setMockUser(USER.aSteward);
    const n = serve("PENDING");
    const { result } = renderHook(() => useGetDatasetVersion(VERSION.electrolyte, { pollMs: 20, pollPending: true }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => expect(n.calls).toBeGreaterThan(2));
  });

  it("polls while the server is verifying UPLOADED files", async () => {
    setMockUser(USER.aSteward);
    const n = serve("UPLOADED");
    renderHook(() => useGetDatasetVersion(VERSION.electrolyte, { pollMs: 20 }), { wrapper: wrapper() });
    await waitFor(() => expect(n.calls).toBeGreaterThan(2));
  });
});

describe("scoped invalidation", () => {
  const ok = (body: unknown = {}) => HttpResponse.json(body as Record<string, unknown>);

  it("publish invalidates only the version's dataset, versions list and readiness", async () => {
    setMockUser(USER.aSteward);
    server.use(http.post("*/mock-api/v1/dataset-versions/:id/publish", () => ok({ dataset_version_id: VERSION.electrolyte, dataset_id: DATASET.electrolyte })));
    const client = makeQueryClient({ retry: false });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => usePublishDatasetVersion(VERSION.electrolyte), { wrapper: wrapper(client) });
    await act(() => result.current.mutateAsync());
    expect(keys(spy)).toEqual([
      JSON.stringify(["getDatasetVersion"]), // narrowed by a predicate to this dataset's versions
      JSON.stringify(["listDatasetVersions", { datasetId: DATASET.electrolyte }]),
      JSON.stringify(["getDataset", { datasetId: DATASET.electrolyte }]),
      JSON.stringify(["getReadiness", { versionId: VERSION.electrolyte }]),
      JSON.stringify(["searchDatasets"]),
      JSON.stringify(["compareVersions"]),
      JSON.stringify(["fileHistory", { datasetId: DATASET.electrolyte }]),
    ]);
  });

  it("createDatasetVersion also refreshes the dataset", async () => {
    setMockUser(USER.aSteward);
    server.use(http.post("*/mock-api/v1/datasets/:id/versions", () => ok({ dataset_version_id: "x" })));
    const client = makeQueryClient({ retry: false });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useCreateDatasetVersion(DATASET.battery), { wrapper: wrapper(client) });
    await act(() => result.current.mutateAsync({ version_label: "v9" }));
    expect(keys(spy)).toEqual([JSON.stringify(["listDatasetVersions", { datasetId: DATASET.battery }]), JSON.stringify(["getDataset", { datasetId: DATASET.battery }])]);
  });

  it("createAccessRequest scopes getDataset to the requested dataset", async () => {
    setMockUser(USER.aResearcher);
    server.use(http.post("*/mock-api/v1/access-requests", () => ok({ access_request_id: "r" })));
    const client = makeQueryClient({ retry: false });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useCreateAccessRequest(), { wrapper: wrapper(client) });
    await act(() =>
      result.current.mutateAsync({ dataset_id: DATASET.battery, project_id: PROJECT.seed, purpose: "ACADEMIC_RESEARCH", purpose_detail: "x".repeat(40), operations: ["READ"], requested_days: 30 }),
    );
    expect(keys(spy)).toEqual([JSON.stringify(["listAccessRequests"]), JSON.stringify(["getDataset", { datasetId: DATASET.battery }])]);
  });

  it("only approve refreshes access grants", async () => {
    setMockUser(USER.aSteward);
    server.use(
      http.post("*/mock-api/v1/access-requests/:id/start-review", () => ok({ access_request_id: "r" })),
      http.post("*/mock-api/v1/access-requests/:id/approve", () => ok({ access_request: { access_request_id: "r" }, access_grant: null })),
    );
    const client = makeQueryClient({ retry: false });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => ({ review: useStartAccessReview("r"), approve: useApproveAccessRequest("r") }), { wrapper: wrapper(client) });
    await act(() => result.current.review.mutateAsync());
    expect(keys(spy)).not.toContain(JSON.stringify(["listAccessGrants"]));
    spy.mockClear();
    await act(() => result.current.approve.mutateAsync({ approved_days: 30 } as never));
    expect(keys(spy)).toContain(JSON.stringify(["listAccessGrants"]));
  });

  it("file mutations refresh the version and its dataset's version list", async () => {
    setMockUser(USER.aSteward);
    server.use(http.delete("*/mock-api/v1/dataset-versions/:id/files/:fid", () => new HttpResponse(null, { status: 204 })));
    const client = makeQueryClient({ retry: false });
    client.setQueryData(["getDatasetVersion", { versionId: VERSION.electrolyte }], { dataset_id: DATASET.electrolyte });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useDeleteDraftFile(VERSION.electrolyte), { wrapper: wrapper(client) });
    await act(() => result.current.mutateAsync("f1"));
    expect(keys(spy)).toEqual([
      JSON.stringify(["getDatasetVersion", { versionId: VERSION.electrolyte }]),
      JSON.stringify(["compareVersions", { versionId: VERSION.electrolyte }]),
      JSON.stringify(["listDatasetVersions", { datasetId: DATASET.electrolyte }]),
    ]);
  });
});
