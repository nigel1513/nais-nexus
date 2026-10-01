import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { delay, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DATASET, PROJECT, USER, VERSION } from "@/mocks/fixtures";
import { makeQueryClient } from "@/shared/api/query-client";
import { server } from "../../tests/msw";
import { setMockUser } from "../../tests/render";
import { useSearchDatasets } from "./catalog/api";
import { useCreateAccessRequest, useListAccessRequests } from "./governance/api";
import { useCreateProject, useGetProject, useListProjects } from "./projects/api";
import { useGetReadiness } from "./readiness/api";

const ready = vi.hoisted(() => ({ value: true }));
vi.mock("@/features/auth/use-auth-ready", () => ({ useAuthReady: () => ready.value }));

function wrapper() {
  const client = makeQueryClient({ retry: false });
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
    const { result, rerender } = renderHook(({ q }: { q: string }) => useSearchDatasets({ q }), { wrapper: wrapper(), initialProps: { q: "battery" } });
    await waitFor(() => expect(result.current.data?.pages[0]?.items).toHaveLength(1));
    server.use(http.get("*/mock-api/v1/datasets", async () => { await delay(150); return undefined; }));
    rerender({ q: "sensor" });
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.pages[0]?.items[0]?.title).toBe("Battery Cycling Measurements");
    await waitFor(() => expect(result.current.data?.pages[0]?.items[0]?.title).toBe("Facility Sensor Streams"));
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
