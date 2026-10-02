"use client";
import { Button, copyText, FormField, IconButton, PathText, Select, splitForMiddleEllipsis } from "@nais/ui";
import { Check, Copy, Download, FileText } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { decideAccessCta } from "@/features/catalog/access-cta";
import { useListProjects } from "@/features/projects/api";
import { flattenPages } from "@/shared/api/pagination";
import type { Dataset, DownloadSession } from "@/shared/api/types";
import { formatCountdown, useCountdown } from "@/shared/hooks/use-countdown";
import { useMeData } from "@/shared/hooks/use-me";
import { formatBytes } from "@/shared/lib/format";
import { notify } from "@/shared/ui/toast";
import { ErrorView } from "@/shared/ui/state-views";
import { useCreateDownloadSession, useListAccessGrants } from "../api";

function triggerDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Copy a file's SHA-256 (works on plain http via copyText); if every copy path fails the full value is shown to select by hand. */
function CopySha({ path, sha }: { path: string; sha: string }) {
  const t = useTranslations();
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  useEffect(() => {
    if (state !== "copied") return;
    const id = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(id);
  }, [state]);
  return (
    <>
      <IconButton
        label={t("download.copyShaFor", { path })}
        size="sm"

        onClick={async () => {
          if (await copyText(sha)) {
            setState("copied");
            notify.success(t("download.copiedSha"));
          } else {
            setState("manual");
            notify.error(t("download.copyFailed"));
          }
        }}
      >
        {state === "copied" ? <Check aria-hidden="true" className="text-success" /> : <Copy aria-hidden="true" />}
      </IconButton>
      {state === "manual" ? (
        <code className="col-span-full block select-all break-all rounded-sm bg-bg-subtle px-2 py-1 font-mono text-mono text-fg">{sha}</code>
      ) : null}
    </>
  );
}

/** A file path cut in the middle (root and file name stay visible); the text content is still the whole path. */
function MiddlePath({ path }: { path: string }) {
  const [head, tail] = splitForMiddleEllipsis(path);
  return (
    <>
      <span className="min-w-0 truncate">{head}</span>
      <span className="shrink-0 whitespace-pre">{tail}</span>
    </>
  );
}

/**
 * Presigned URLs live only in component state: never logged, stored or sent elsewhere (M10 §10.4).
 * The server decides every request; the UI only pre-selects a project.
 */
export function DownloadPanel({ dataset, versionId, focus = false }: { dataset: Dataset; versionId: string; focus?: boolean }) {
  const t = useTranslations();
  const me = useMeData();
  const create = useCreateDownloadSession(versionId);
  const grants = useListAccessGrants({ role: "subject", dataset_id: dataset.dataset_id, status: ["ACTIVE"] });
  const projects = useListProjects({ scope: "mine", status: "ACTIVE", limit: 100 });
  const cta = decideAccessCta({
    accessLevel: dataset.access_level,
    ownerOrganizationId: dataset.owner_organization_id,
    me,
    activeGrants: flattenPages(grants.data),
    requests: [],
  });
  const needsProject = cta.kind !== "download";
  const projectOptions = useMemo(() => {
    const all = flattenPages(projects.data).map((p) => ({ project_id: p.project_id, name: p.name }));
    if (cta.kind === "download-grant") {
      // Grants may span several projects (some possibly beyond the first project page): offer every granted project.
      const known = new Map(all.map((p) => [p.project_id, p.name]));
      const ids = [...new Set(cta.grants.map((g) => g.project_id))];
      return ids.map((id) => ({ project_id: id, name: known.get(id) ?? id }));
    }
    return all;
  }, [cta, projects.data]);
  const [projectId, setProjectId] = useState("");
  const chosenProject = projectId || (projectOptions.length === 1 ? projectOptions[0]!.project_id : "");
  const [session, setSession] = useState<DownloadSession | null>(null);
  const [error, setError] = useState<unknown>(null);
  const left = useCountdown(session?.expires_at ?? null);
  const expired = !!session && left === 0;
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focus) headingRef.current?.focus();
  }, [focus]);

  const request = () => {
    setError(null);
    setSession(null);
    create.mutate(needsProject ? { project_id: chosenProject } : {}, {
      onSuccess: (s) => {
        setSession(s);
        if (s.files.length === 1) triggerDownload(s.files[0]!.url);
      },
      onError: (e) => setError(e),
    });
  };

  return (
    <section aria-labelledby="download-title" className="rounded-md border border-border bg-bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 id="download-title" ref={headingRef} tabIndex={-1} className="text-heading text-fg focus:outline-none">
          {t("download.title")}
        </h2>
        {session && !error ? (
          <p className={expired ? "text-small text-danger" : "num text-small text-fg-muted"} aria-live="off">
            {expired ? t("download.expired") : t("download.expiresIn", { time: formatCountdown(left) })}
          </p>
        ) : null}
      </div>
      {needsProject && projectOptions.length > 1 ? (
        <div className="max-w-sm px-4 pt-4">
          <FormField id="download-project" label={t("download.project")} hint={t("download.projectHint")}>
            {(a11y) => (
              <Select {...a11y} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">{t("access.request.chooseProject")}</option>
                {projectOptions.map((p) => (
                  <option key={p.project_id} value={p.project_id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>
      ) : null}
      {!session || expired ? (
        <div className="px-4 py-4">
          <Button variant="primary" onClick={request} loading={create.isPending} disabled={needsProject && !chosenProject}>
            <Download aria-hidden="true" />
            {expired ? t("download.renew") : t("download.request")}
          </Button>
        </div>
      ) : null}
      {error ? (
        <div className="px-4 pb-4">
          <ErrorView error={error} />
        </div>
      ) : null}
      {session && !error ? (
        <>
          <ul className="divide-y divide-border">
            {session.files.map((f) => (
              <li
                key={f.file_id}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2 md:grid-cols-[minmax(0,1fr)_5rem_11rem_auto]"
              >
                <span className="flex min-w-0 items-center gap-2 max-md:col-span-full">
                  <FileText aria-hidden="true" className="size-4 shrink-0 text-fg-muted" strokeWidth={1.75} />
                  {expired ? (
                    <span aria-disabled="true" className="flex min-w-0 font-mono text-mono text-fg-subtle line-through">
                      <MiddlePath path={f.path} />
                    </span>
                  ) : (
                    <a
                      href={f.url}
                      download
                      target="_blank"
                      rel="noopener noreferrer"
                      title={f.path}
                      className="flex min-w-0 font-mono text-mono text-fg underline-offset-4 hover:underline"
                    >
                      <MiddlePath path={f.path} />
                    </a>
                  )}
                </span>
                <span className="num text-small text-fg-muted md:text-right">{formatBytes(f.size_bytes)}</span>
                <PathText value={f.sha256} className="text-fg-muted max-md:justify-self-end" />
                <CopySha path={f.path} sha={f.sha256} />
              </li>
            ))}
          </ul>
          <p className="border-t border-border px-4 py-3 text-small text-fg-muted">{t("download.verifyHint")}</p>
        </>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {expired ? t("download.expired") : ""}
      </p>
    </section>
  );
}
