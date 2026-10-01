"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@/shared/api/client";
import type { Schemas, UploadSession } from "@/shared/api/types";

type Parts = { file_id: string; etags: { part_number: number; etag: string }[] }[];

function useVersionInvalidation(versionId: string) {
  const qc = useQueryClient();
  return () => {
    const datasetId = qc.getQueryData<{ dataset_id?: string }>(["getDatasetVersion", { versionId }])?.dataset_id;
    void qc.invalidateQueries({ queryKey: ["getDatasetVersion", { versionId }] });
    // file_count lives on the version list; refresh that dataset's list (all lists if the version is not cached).
    void qc.invalidateQueries({ queryKey: datasetId ? ["listDatasetVersions", { datasetId }] : ["listDatasetVersions"] });
  };
}

export function useCreateUploadSession(versionId: string) {
  const invalidate = useVersionInvalidation(versionId);
  return useMutation({
    mutationFn: async (body: Schemas["UploadSessionCreate"]) =>
      (await unwrap(api.POST("/dataset-versions/{version_id}/upload-session", { params: { path: { version_id: versionId } }, body }))) as UploadSession,
    onSuccess: invalidate,
  });
}

export function useCompleteUploadSession(versionId: string) {
  const invalidate = useVersionInvalidation(versionId);
  return useMutation({
    mutationFn: async ({ uploadSessionId, parts }: { uploadSessionId: string; parts?: Parts }) =>
      (await unwrap(
        api.POST("/upload-sessions/{upload_session_id}/complete", { params: { path: { upload_session_id: uploadSessionId } }, body: parts?.length ? { parts } : {} }),
      )) as UploadSession,
    onSettled: invalidate,
  });
}

export function useDeleteDraftFile(versionId: string) {
  const invalidate = useVersionInvalidation(versionId);
  return useMutation({
    mutationFn: (fileId: string) => unwrap(api.DELETE("/dataset-versions/{version_id}/files/{file_id}", { params: { path: { version_id: versionId, file_id: fileId } } })),
    onSuccess: invalidate,
  });
}
