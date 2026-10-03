import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DATASET, USER, VERSION } from "@/mocks/fixtures";
import { ApiError } from "@/shared/api/errors";
import { makeQueryClient } from "@/shared/api/query-client";
import { setMockUser } from "../../../../tests/render";
import { getDb } from "@/mocks/db";
import type { DatasetVersion } from "@/shared/api/types";
import { useCompleteUploadSession } from "@/features/upload/api";
import { useCreateDatasetVersion, useGetDatasetVersion, useListDatasetVersions, usePublishDatasetVersion } from "../api";
import { useCitation, useCompareVersions, useDiscardDraft, useFileHistory, useRebaseDraft, useUpdateVersionNote } from "./api";

vi.mock("@/features/auth/use-auth-ready", () => ({ useAuthReady: () => true }));

function wrapper(client = makeQueryClient({ retry: false })) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("cache freshness after publish and upload (final review M2)", () => {
  it("publishing refreshes every cached version of the dataset (siblings' base_is_latest), not other datasets", async () => {
    setMockUser(USER.bSteward);
    const client = makeQueryClient({ retry: false });
    const view = (id: string, datasetId: string) => ({ dataset_version_id: id, dataset_id: datasetId }) as DatasetVersion;
    client.setQueryData(["getDatasetVersion", { versionId: VERSION.batteryV11 }], view(VERSION.batteryV11, DATASET.battery));
    client.setQueryData(["getDatasetVersion", { versionId: VERSION.openMaterials }], view(VERSION.openMaterials, DATASET.openMaterials));
    const { result } = renderHook(() => usePublishDatasetVersion(VERSION.batteryDraft), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(getDb().versions.find((v) => v.dataset_version_id === VERSION.batteryDraft)!.status).toBe("PUBLISHED");
    expect(client.getQueryState(["getDatasetVersion", { versionId: VERSION.batteryV11 }])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["getDatasetVersion", { versionId: VERSION.openMaterials }])?.isInvalidated).toBe(false);
  });

  it("completing an upload refreshes that version's comparisons", async () => {
    setMockUser(USER.bSteward);
    const client = makeQueryClient({ retry: false });
    client.setQueryData(["compareVersions", { versionId: VERSION.batteryDraft, against: undefined }], { summary: {} });
    client.setQueryData(["compareVersions", { versionId: VERSION.battery, against: undefined }], { summary: {} });
    const { result } = renderHook(() => useCompleteUploadSession(VERSION.batteryDraft), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync({ uploadSessionId: "00000000-0000-7000-8000-00000000dead" }).catch(() => undefined);
    });
    expect(client.getQueryState(["compareVersions", { versionId: VERSION.batteryDraft, against: undefined }])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["compareVersions", { versionId: VERSION.battery, against: undefined }])?.isInvalidated).toBe(false);
  });
});

describe("version hooks", () => {
  it("reads diff, file history and citation", async () => {
    setMockUser(USER.bSteward);
    const { result } = renderHook(
      () => ({ diff: useCompareVersions(VERSION.batteryDraft), history: useFileHistory(DATASET.battery, "README.md"), cite: useCitation(VERSION.battery, "bibtex") }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.diff.isSuccess && result.current.history.isSuccess && result.current.cite.isSuccess).toBe(true));
    expect(result.current.diff.data?.from_version_id).toBe(VERSION.battery);
    expect(result.current.history.data?.items.map((i) => i.state)).toEqual(["ADDED", "CHANGED", "CHANGED"]);
    expect(result.current.cite.data?.content).toContain("@misc{");
  });

  it("does not fetch history without a path or a citation without a version", () => {
    setMockUser(USER.bSteward);
    const { result } = renderHook(() => ({ h: useFileHistory(DATASET.battery, null), c: useCitation(null) }), { wrapper: wrapper() });
    expect(result.current.h.fetchStatus).toBe("idle");
    expect(result.current.c.fetchStatus).toBe("idle");
  });

  it("creates, annotates, rebases and discards a draft, keeping the lists fresh", async () => {
    setMockUser(USER.bSteward);
    const client = makeQueryClient({ retry: false });
    const spy = vi.spyOn(client, "invalidateQueries");
    const list = renderHook(() => useListDatasetVersions(DATASET.battery), { wrapper: wrapper(client) });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    const count = list.result.current.data!.items.length;
    const create = renderHook(() => useCreateDatasetVersion(DATASET.battery), { wrapper: wrapper(client) });
    const draft = await act(() => create.result.current.mutateAsync({ version_label: "v9", empty: true }));
    await waitFor(() => expect(list.result.current.data!.items).toHaveLength(count + 1));
    expect(draft.files).toEqual([]);

    const note = renderHook(() => useUpdateVersionNote(draft.dataset_version_id), { wrapper: wrapper(client) });
    const noted = await act(() => note.result.current.mutateAsync("메모 저장"));
    expect(noted.change_note).toBe("메모 저장");
    expect(client.getQueryData(["getDatasetVersion", { versionId: draft.dataset_version_id }])).toMatchObject({ change_note: "메모 저장" });

    const rebase = renderHook(() => useRebaseDraft(draft.dataset_version_id), { wrapper: wrapper(client) });
    expect((await act(() => rebase.result.current.mutateAsync())).base_is_latest).toBe(true);

    const discard = renderHook(() => useDiscardDraft(DATASET.battery), { wrapper: wrapper(client) });
    await act(() => discard.result.current.mutateAsync(draft.dataset_version_id));
    await waitFor(() => expect(list.result.current.data!.items).toHaveLength(count));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["listDatasetVersions", { datasetId: DATASET.battery }] });

    const gone = renderHook(() => useGetDatasetVersion(draft.dataset_version_id), { wrapper: wrapper() });
    await waitFor(() => expect(gone.result.current.error).toBeInstanceOf(ApiError));
  });

  it("rebases a draft that went stale after another draft was published", async () => {
    setMockUser(USER.bSteward);
    const client = makeQueryClient({ retry: false });
    const create = renderHook(() => useCreateDatasetVersion(DATASET.battery), { wrapper: wrapper(client) });
    const a = await act(() => create.result.current.mutateAsync({ version_label: "v9-a" }));
    const b = await act(() => create.result.current.mutateAsync({ version_label: "v9-b" }));
    await act(async () => {
      const send = (path: string, method: string, body?: unknown) =>
        fetch(`http://localhost:3000/mock-api/v1${path}`, { method, headers: { "x-mock-user": USER.bSteward, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      await send(`/dataset-versions/${a.dataset_version_id}`, "PATCH", { change_note: "먼저 게시" });
      await send(`/dataset-versions/${a.dataset_version_id}/publish`, "POST");
    });
    const rebase = renderHook(() => useRebaseDraft(b.dataset_version_id), { wrapper: wrapper(client) });
    const v = await act(() => rebase.result.current.mutateAsync({}));
    expect(v.base_version_id).toBe(a.dataset_version_id);
  });
});
