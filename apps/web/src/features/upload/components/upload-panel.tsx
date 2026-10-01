"use client";
import { Button, FileDropzone, Table, TBody, Td, Th, THead, Tr } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useGetDatasetVersion } from "@/features/catalog/api";
import type { UploadSession } from "@/shared/api/types";
import { asApiError } from "@/shared/api/errors";
import { formatBytes } from "@/shared/lib/format";
import { ErrorView } from "@/shared/ui/state-views";
import { useCompleteUploadSession, useCreateUploadSession } from "../api";
import { hashFile } from "../lib/hash-client";
import { mediaTypeFor, suggestPath, uploadMessageParams, validatePath, validateSelection, type SelectionIssue } from "../lib/paths";
import { transferSession, type PreparedFile } from "../lib/run-upload";

type RowStatus = "ready" | "hashing" | "hashed" | "uploading" | "PENDING" | "UPLOADED" | "VERIFIED" | "FAILED";
type Row = { key: number; file: File; path: string; size: number; media_type: string; sha256?: string; progress: number; status: RowStatus; failure?: string | null };

let seq = 0;

export function UploadPanel({ versionId }: { versionId: string }) {
  const t = useTranslations();
  const limits = uploadMessageParams();
  const version = useGetDatasetVersion(versionId, { pollMs: 1500 });
  const abortRef = useRef<AbortController | null>(null);
  // A cancelled run leaves its session open on the server (its paths stay PENDING), so the next start resumes it.
  const resumeRef = useRef<UploadSession | null>(null);
  const createSession = useCreateUploadSession(versionId);
  const complete = useCompleteUploadSession(versionId);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [expired, setExpired] = useState(false);
  const [announce, setAnnounce] = useState("");

  useEffect(() => () => abortRef.current?.abort(), []);

  // UPLOADED rows follow the version's file list until the server verifies them (UPLOADED → VERIFIED | FAILED).
  useEffect(() => {
    const files = version.data?.files;
    if (!files) return;
    setRows((prev) => {
      let changed = false;
      const next = prev.map((r) => {
        if (r.status !== "UPLOADED" && r.status !== "PENDING") return r;
        const f = files.find((x) => x.path === r.path);
        if (!f || (f.status !== "VERIFIED" && f.status !== "FAILED")) return r;
        changed = true;
        return { ...r, status: f.status, failure: (f as { failure_code?: string | null }).failure_code ?? (f.status === "FAILED" ? "UNKNOWN" : null) };
      });
      return changed ? next : prev;
    });
  }, [version.data]);

  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const selection = validateSelection(rows.map((r) => ({ path: r.path, size: r.size })));
  const issuesFor = (index: number) => selection.issues.filter((i) => i.index === index);
  const pathIssueCount = rows.filter((r) => validatePath(r.path)).length;
  const blocking = selection.issues.length > 0 || selection.tooMany;
  // Only rows that were never sent (ready/hashed); UPLOADED/PENDING rows are still being verified by the server.
  const pending = rows.filter((r) => r.status === "ready" || r.status === "hashed");
  const failed = rows.filter((r) => r.status === "FAILED");

  const patch = (key: number, p: Partial<Row>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const addFiles = (files: File[]) =>
    setRows((prev) => [
      ...prev,
      ...files.map((f) => ({
        key: ++seq,
        file: f,
        path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
        size: f.size,
        media_type: mediaTypeFor(f.name, f.type),
        progress: 0,
        status: "ready" as const,
      })),
    ]);

  const autoConvert = () =>
    setRows((prev) => {
      const taken = new Set(prev.filter((r) => !validatePath(r.path)).map((r) => r.path));
      return prev.map((r) => {
        if (!validatePath(r.path)) return r;
        const path = suggestPath(r.path, taken);
        taken.add(path);
        return { ...r, path };
      });
    });

  const run = async (targets: Row[]) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setExpired(false);
    let sessionRef: UploadSession | null = null;
    try {
      const prepared: PreparedFile[] = [];
      for (const r of targets) {
        let sha = r.sha256; // kept in memory: an expired session restarts without re-hashing (M10 §9.7)
        if (!sha) {
          patch(r.key, { status: "hashing", progress: 0 });
          sha = await hashFile(r.file, (bytes) => patch(r.key, { progress: r.size ? bytes / r.size : 1 }), controller.signal);
        }
        patch(r.key, { sha256: sha, status: "hashed", progress: 0 });
        prepared.push({ file: r.file, path: r.path, size: r.size, sha256: sha, media_type: r.media_type });
      }
      const resumable = resumeRef.current;
      resumeRef.current = null;
      const session =
        resumable && prepared.every((p) => resumable.files.some((f) => f.path === p.path && (f.status === "PENDING" || f.status === "FAILED")))
          ? resumable
          : await createSession.mutateAsync({
              files: prepared.map(({ path, size, sha256, media_type }) => ({ path, size_bytes: size, sha256, media_type })),
            });
      sessionRef = session;
      const keyByPath = new Map(targets.map((r) => [r.path, r]));
      for (const r of targets) patch(r.key, { status: "uploading", progress: 0 });
      const parts = await transferSession(session, prepared, {
        signal: controller.signal,
        onProgress: (path, bytes) => {
          const row = keyByPath.get(path);
          if (row) patch(row.key, { progress: row.size ? Math.min(1, bytes / row.size) : 1 });
        },
      });
      const result = await complete.mutateAsync({ uploadSessionId: session.upload_session_id, parts });
      for (const f of result.files) {
        const row = keyByPath.get(f.path);
        if (row) patch(row.key, { status: f.status, failure: f.failure_code ?? (f.status === "FAILED" ? "UNKNOWN" : null), progress: 1 });
      }
      const failedCount = result.files.filter((f) => f.status === "FAILED").length;
      setAnnounce(failedCount ? t("upload.announce.partial", { failed: failedCount }) : t("upload.announce.done", { count: result.files.length }));
    } catch (e) {
      if (controller.signal.aborted) resumeRef.current = sessionRef;
      else {
        if (asApiError(e).code === "UPLOAD_SESSION_EXPIRED") setExpired(true);
        setError(e);
      }
      setRows((prev) => prev.map((r) => (r.status === "hashing" || r.status === "uploading" ? { ...r, status: "ready" } : r)));
    } finally {
      setBusy(false);
    }
  };

  const issueText = (i: SelectionIssue) => t(`upload.issue.${i.code}`, limits);

  return (
    <section aria-labelledby="upload-title" className="flex flex-col gap-3">
      <h2 id="upload-title" className="text-lg font-semibold">
        {t("upload.title")}
      </h2>
      <FileDropzone
        label={t("upload.dropLabel")}
        hint={t("upload.dropHint", limits)}
        fileButtonLabel={t("upload.chooseFiles")}
        folderButtonLabel={t("upload.chooseFolder")}
        disabled={busy}
        onFiles={addFiles}
      />
      {selection.tooMany ? <p role="alert" className="text-sm text-danger">{t("upload.tooMany")}</p> : null}
      {pathIssueCount > 0 ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-warning p-3 text-sm">
          <span>{t("upload.pathIssues", { count: pathIssueCount })}</span>
          <Button size="sm" variant="outline" onClick={autoConvert} disabled={busy}>
            {t("upload.autoConvert")}
          </Button>
        </div>
      ) : null}
      {rows.length ? (
        <Table caption={t("upload.caption")}>
          <THead>
            <Tr>
              <Th>{t("version.files.path")}</Th>
              <Th>{t("version.files.size")}</Th>
              <Th>{t("version.files.status")}</Th>
              <Th>{t("common.actions")}</Th>
            </Tr>
          </THead>
          <TBody>
            {rows.map((r, index) => (
              <Tr key={r.key}>
                <Td>
                  <code className="break-all">{r.path}</code>
                  {issuesFor(index).map((i) => (
                    <p key={i.code} className="text-xs text-danger">
                      {issueText(i)}
                    </p>
                  ))}
                  {r.failure ? <p className="text-xs text-danger">{t.has(`upload.failure.${r.failure}`) ? t(`upload.failure.${r.failure}`) : t("upload.failure.generic")}</p> : null}
                </Td>
                <Td>{formatBytes(r.size)}</Td>
                <Td>
                  <span className="block text-sm">{t(`upload.status.${r.status}`)}</span>
                  {r.status === "hashing" || r.status === "uploading" ? (
                    <progress className="w-32" value={r.progress} max={1} aria-label={t("upload.progressFor", { path: r.path })} />
                  ) : null}
                </Td>
                <Td>
                  <Button size="sm" variant="ghost" disabled={busy} aria-label={t("upload.removeFile", { path: r.path })} onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}>
                    {t("upload.remove")}
                  </Button>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : null}
      {error ? <ErrorView error={error} params={limits} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || blocking || pending.length === 0} onClick={() => void run(pending)}>
          {expired ? t("upload.restartExpired") : t("upload.start")}
        </Button>
        {busy ? (
          <Button variant="outline" onClick={() => abortRef.current?.abort()}>
            {t("upload.cancel")}
          </Button>
        ) : null}
        {failed.length > 0 && !busy ? (
          <Button variant="outline" onClick={() => void run(failed)}>
            {t("upload.retryFailed")}
          </Button>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </section>
  );
}
