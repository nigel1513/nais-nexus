"use client";
import { Button, FormField, Select } from "@nais/ui";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { decideAccessCta } from "@/features/catalog/access-cta";
import { useListProjects } from "@/features/projects/api";
import { flattenPages } from "@/shared/api/pagination";
import type { Dataset, DownloadSession } from "@/shared/api/types";
import { formatCountdown, useCountdown } from "@/shared/hooks/use-countdown";
import { useMeData } from "@/shared/hooks/use-me";
import { formatBytes, shortHash } from "@/shared/lib/format";
import { CopyShaButton } from "@/shared/ui/copy-sha-button";
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
    <section aria-labelledby="download-title" className="flex flex-col gap-3">
      <h2 id="download-title" ref={headingRef} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
        {t("download.title")}
      </h2>
      {needsProject && projectOptions.length > 1 ? (
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
      ) : null}
      {!session || expired ? (
        <div>
          <Button onClick={request} disabled={create.isPending || (needsProject && !chosenProject)}>
            {expired ? t("download.renew") : t("download.request")}
          </Button>
        </div>
      ) : null}
      {error ? <ErrorView error={error} /> : null}
      {session && !error ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm" aria-live="off">
            {expired ? t("download.expired") : t("download.expiresIn", { time: formatCountdown(left) })}
          </p>
          <ul className="flex flex-col gap-2">
            {session.files.map((f) => (
              <li key={f.file_id} className="flex flex-wrap items-center gap-3 text-sm">
                {expired ? (
                  <span aria-disabled="true" className="text-muted-foreground line-through">
                    {f.path}
                  </span>
                ) : (
                  <a href={f.url} download target="_blank" rel="noopener noreferrer" className="font-medium underline">
                    {f.path}
                  </a>
                )}
                <span className="text-muted-foreground">{formatBytes(f.size_bytes)}</span>
                <code title={f.sha256}>{shortHash(f.sha256)}</code>
                <CopyShaButton path={f.path} sha={f.sha256} />
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t("download.verifyHint")}</p>
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {expired ? t("download.expired") : ""}
      </p>
    </section>
  );
}
