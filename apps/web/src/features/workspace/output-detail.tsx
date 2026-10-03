"use client";
import { Badge, Button, DataTable, Table, TBody, Td, Th, THead, Tr } from "@nais/ui";
import { Download, Globe, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { flattenPages } from "@/shared/api/pagination";
import type { Schemas } from "@/shared/api/types";
import { useErrorText } from "@/shared/api/use-error-text";
import { formatBytes } from "@/shared/lib/format";
import { AccessLevelBadge, OutputPublishBadge, PublishRequestBadge } from "@/shared/ui/badges";
import { CopyShaButton } from "@/shared/ui/copy-sha-button";
import { DateTime } from "@/shared/ui/date-text";
import { DelayedSkeleton, ErrorView } from "@/shared/ui/state-views";
import { PanelHead } from "@/shared/ui/work-hero";
import { useOutput, useOutputDownload, useProjectInputs, usePublishRequests, useRecipes, type Output } from "./api";
import { TargetDiscussion } from "./discussion-tab";
import { PublishDialog } from "./publish-dialog";
import { projectHref, useDetailCrumb, useWorkspace } from "./workspace-layout";

const linkClass = "font-medium text-fg underline-offset-4 hover:underline";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

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
 * Lineage as three columns — inputs (dataset@version) → recipe@version (or 업로드) → this output. The SVG is a picture
 * (role=img with title/desc); the list next to it carries the same facts with links.
 */
export function LineageGraph({ output, recipeName }: { output: Output; recipeName: string | null }) {
  const t = useTranslations();
  const titleId = useId();
  const descId = useId();
  const inputs = output.lineage.inputs;
  const middle = output.lineage.recipe_id ? `${clip(recipeName ?? t("workspace.runs.deletedRecipe"), 14)} @v${output.lineage.recipe_version}` : t("workspace.lineage.upload");
  const W = 720;
  const NODE_W = 220;
  const NODE_H = 44;
  const GAP = 12;
  const rows = Math.max(1, inputs.length);
  const H = rows * (NODE_H + GAP) - GAP + 16;
  const cy = H / 2;
  const colX = [0, (W - NODE_W) / 2, W - NODE_W];
  const inputY = (i: number) => 8 + i * (NODE_H + GAP);
  const desc = t("workspace.lineage.desc", {
    inputs: inputs.length ? inputs.map((i) => `${i.dataset_title} ${i.version_label}`).join(", ") : t("workspace.lineage.noInputs"),
    middle,
    output: output.title,
  });
  const node = (x: number, y: number, label: string, sub: string, accent = false) => (
    <g>
      <rect x={x + 0.5} y={y + 0.5} width={NODE_W - 1} height={NODE_H - 1} rx={6} fill={accent ? "var(--color-accent-soft, var(--color-bg-hover))" : "var(--color-bg-panel)"} stroke={accent ? "var(--color-accent)" : "var(--color-border-strong)"} />
      <text x={x + 12} y={y + 19} fontSize={13} fontWeight={600} fill="var(--color-fg)">
        {clip(label, 18)}
      </text>
      <text x={x + 12} y={y + 35} fontSize={11} fill="var(--color-fg-muted)">
        {sub}
      </text>
    </g>
  );
  const edge = (x1: number, y1: number, x2: number, y2: number, key: string) => {
    const mx = (x1 + x2) / 2;
    return <path key={key} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke="var(--color-border-strong)" strokeWidth={1.25} />;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${titleId} ${descId}`} className="hidden h-auto w-full max-w-[720px] sm:block">
      <title id={titleId}>{t("workspace.lineage.title")}</title>
      <desc id={descId}>{desc}</desc>
      {inputs.map((_, i) => edge(colX[0]! + NODE_W, inputY(i) + NODE_H / 2, colX[1]!, cy, `e${i}`))}
      {edge(colX[1]! + NODE_W, cy, colX[2]!, cy, "out")}
      {inputs.length
        ? inputs.map((i, k) => <g key={i.dataset_version_id}>{node(colX[0]!, inputY(k), i.dataset_title, i.version_label)}</g>)
        : node(colX[0]!, cy - NODE_H / 2, t("workspace.lineage.noInputs"), "—")}
      {node(colX[1]!, cy - NODE_H / 2, middle, output.lineage.run_id ? t("workspace.lineage.run") : t("workspace.lineage.uploadSub"))}
      {node(colX[2]!, cy - NODE_H / 2, output.title, t(`enums.OutputKind.${output.kind}`), true)}
    </svg>
  );
}

function LineageList({ output, recipeName }: { output: Output; recipeName: string | null }) {
  const t = useTranslations();
  const { project } = useWorkspace();
  const l = output.lineage;
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-small sm:grid-cols-[8rem_minmax(0,1fr)]">
      <dt className="text-fg-muted">{t("workspace.lineage.inputs")}</dt>
      <dd>
        {l.inputs.length ? (
          <ul className="flex flex-col gap-1">
            {l.inputs.map((i) => (
              <li key={i.dataset_version_id} className="flex flex-wrap items-baseline gap-2">
                <Link href={`/commons/data/${i.dataset_id}`} className={linkClass}>
                  {i.dataset_title}
                </Link>
                <span className="num font-mono text-mono text-fg-muted">{i.version_label}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-fg-muted">{t("workspace.lineage.noInputs")}</span>
        )}
      </dd>
      <dt className="text-fg-muted">{t("workspace.lineage.recipe")}</dt>
      <dd>
        {l.recipe_id ? (
          <span className="flex flex-wrap items-baseline gap-2">
            {recipeName ? (
              <Link href={`${projectHref(project.project_id, "recipes")}/${l.recipe_id}`} className={linkClass}>
                {recipeName}
              </Link>
            ) : (
              <span className="text-fg-muted">{t("workspace.runs.deletedRecipe")}</span>
            )}
            <span className="num font-mono text-mono text-fg-muted">v{l.recipe_version}</span>
          </span>
        ) : (
          <span className="text-fg-muted">{t("workspace.lineage.uploaded")}</span>
        )}
      </dd>
      {l.run_id ? (
        <>
          <dt className="text-fg-muted">{t("workspace.lineage.runId")}</dt>
          <dd className="min-w-0 break-all font-mono text-mono text-fg-muted">{l.run_id}</dd>
        </>
      ) : null}
    </dl>
  );
}

function PublishState({ output, onRequest, canRequest }: { output: Output; onRequest: () => void; canRequest: boolean }) {
  const t = useTranslations();
  const { project } = useWorkspace();
  // One page of the project's requests (API maximum 100, newest first) is enough to find this output's latest one; a
  // project with more than 100 publish requests would need a per-output filter, which the contract does not have.
  const requests = usePublishRequests({ role: "requester", project_id: project.project_id, limit: 100 });
  const latest = flattenPages(requests.data).find((r) => r.output_id === output.output_id);
  const again = output.publish_status === "NONE" || output.publish_status === "REJECTED";
  return (
    <section aria-labelledby="ws-publish" className="flex flex-col gap-3">
      <PanelHead
        id="ws-publish"
        crumb={t("workspace.publish.kicker")}
        title={t("workspace.publish.section")}
        right={
          canRequest && again ? (
            <Button variant="primary" onClick={onRequest}>
              <Globe aria-hidden="true" strokeWidth={1.75} />
              {output.publish_status === "REJECTED" ? t("workspace.publish.again") : t("workspace.publish.title")}
            </Button>
          ) : null
        }
      />
      <p className="flex flex-wrap items-center gap-2 text-small text-fg-muted">
        <OutputPublishBadge status={output.publish_status} />
        {output.publish_status === "NONE" ? t("workspace.publish.noneHint") : null}
      </p>
      {requests.isPending ? (
        <DelayedSkeleton lines={2} />
      ) : requests.isError ? (
        <ErrorView error={requests.error} onRetry={() => void requests.refetch()} />
      ) : latest ? (
        <PublishRequestView request={latest} />
      ) : null}
    </section>
  );
}

/** One publish request: status, its approval slots (one per organization), and why it failed when the system rejected it. */
export function PublishRequestView({ request }: { request: Schemas["PublishRequest"] }) {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-3">
      <p className="flex flex-wrap items-center gap-2 text-small text-fg-muted">
        <PublishRequestBadge status={request.status} />
        <span>
          {t("workspace.publish.requestedAt")} <DateTime value={request.created_at} />
        </span>
        {request.published_dataset_id ? (
          <Link href={`/commons/data/${request.published_dataset_id}`} className={linkClass}>
            {t("workspace.publish.openDataset")}
          </Link>
        ) : null}
      </p>
      {request.failure_reason ? (
        <p role="status" className="flex items-start gap-2 rounded-md border border-danger-line bg-danger-soft p-3 text-small text-fg">
          <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-danger" />
          {t("workspace.publish.failed", { reason: request.failure_reason })}
        </p>
      ) : null}
      <Table caption={t("workspace.publish.approvals")}>
        <THead>
          <Tr>
            <Th>{t("workspace.publish.org")}</Th>
            <Th>{t("workspace.publish.decision")}</Th>
            <Th>{t("workspace.publish.comment")}</Th>
            <Th className="text-right">{t("workspace.publish.decidedAt")}</Th>
          </Tr>
        </THead>
        <TBody>
          {request.approvals.map((a) => (
            <Tr key={a.organization_id}>
              <Td>{a.organization_name ?? a.organization_id}</Td>
              <Td>
                {a.decision ? <Badge tone={a.decision === "APPROVE" ? "success" : "danger"}>{t(`enums.PublishDecision.${a.decision}`)}</Badge> : <span className="text-fg-muted">{t("workspace.publish.waiting")}</span>}
              </Td>
              <Td className="max-w-[40ch] whitespace-normal break-words">{a.comment ?? "—"}</Td>
              <Td className="num whitespace-nowrap text-right">{a.decided_at ? <DateTime value={a.decided_at} /> : "—"}</Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

/** 산출물 상세: files and download, lineage, hub publication, discussion. */
export function OutputDetail({ outputId }: { outputId: string }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const { project, canWrite } = useWorkspace();
  const projectId = project.project_id;
  const q = useOutput(projectId, outputId);
  const recipes = useRecipes(projectId);
  const download = useOutputDownload(projectId, outputId);
  const inputs = useProjectInputs(projectId);
  const [publishing, setPublishing] = useState(false);
  useDetailCrumb(q.data ? { label: q.data.title } : null);
  if (q.isPending) return <DelayedSkeleton lines={6} />;
  if (q.isError) return <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  const o = q.data;
  const recipeName = o.lineage.recipe_id ? (recipes.data?.items.find((r) => r.recipe_id === o.lineage.recipe_id)?.name ?? null) : null;
  const session = download.data;
  // The server blocks downloads (INPUT_ACCESS_LAPSED) while any lineage input is out of my reach: say so up front.
  const lapsedIds = new Set((inputs.data?.items ?? []).filter((i) => i.access_lapsed).map((i) => i.dataset_id));
  const lapsedLineage = o.lineage.inputs.filter((i) => lapsedIds.has(i.dataset_id));

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="ws-output-title" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="sv-kicker" aria-hidden="true">
              {t(`enums.OutputKind.${o.kind}`)}
            </span>
            <h2 id="ws-output-title" className="sv-h2 break-keep">
              {o.title}
            </h2>
            <p className="flex flex-wrap items-center gap-2 text-small text-fg-muted">
              <AccessLevelBadge level={o.access_level} />
              <OutputPublishBadge status={o.publish_status} />
              <span>
                <DateTime value={o.created_at} />
              </span>
            </p>
          </div>
          <Button
            variant="primary"
            loading={download.isPending}
            disabled={lapsedLineage.length > 0}
            aria-describedby={lapsedLineage.length ? "ws-download-blocked" : undefined}
            onClick={() =>
              download.mutate(undefined, {
                onSuccess: (s) => {
                  if (s.files.length === 1) triggerDownload(s.files[0]!.url);
                },
              })
            }
          >
            <Download aria-hidden="true" strokeWidth={1.75} />
            {t("workspace.output.download")}
          </Button>
        </div>
        {lapsedLineage.length ? (
          <p id="ws-download-blocked" className="flex items-start gap-2 text-small text-fg">
            <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
            {t("workspace.output.lapsed", { inputs: lapsedLineage.map((i) => i.dataset_title).join(", ") })}
          </p>
        ) : null}
        {download.isError ? (
          <p role="alert" className="flex items-start gap-2 rounded-md border border-warning-line bg-warning-soft p-3 text-small text-fg">
            <TriangleAlert aria-hidden="true" strokeWidth={1.75} className="mt-0.5 size-4 shrink-0 text-warning" />
            {errorText(download.error)}
          </p>
        ) : null}
        <DataTable<Schemas["OutputFile"]>
          caption={t("workspace.output.files")}
          rows={o.files}
          rowKey={(f) => f.name}
          columns={[
            {
              key: "name",
              header: t("workspace.output.file"),
              cell: (f) => {
                const link = session?.files.find((x) => x.name === f.name);
                return link ? (
                  <a href={link.url} download className={`${linkClass} font-mono text-mono`} rel="noopener noreferrer">
                    {f.name}
                  </a>
                ) : (
                  <span className="font-mono text-mono">{f.name}</span>
                );
              },
            },
            { key: "type", header: t("workspace.output.mediaType"), cell: (f) => <span className="text-small text-fg-muted">{f.media_type}</span> },
            { key: "size", header: t("workspace.outputs.size"), numeric: true, cell: (f) => formatBytes(f.size_bytes) },
            { key: "sha", header: "SHA-256", cell: (f) => <CopyShaButton path={f.name} sha={f.sha256} /> },
          ]}
        />
      </section>

      <section aria-labelledby="ws-lineage" className="flex flex-col gap-4">
        <PanelHead id="ws-lineage" crumb={t("workspace.lineage.kicker")} title={t("workspace.lineage.title")} />
        <LineageGraph output={o} recipeName={recipeName} />
        <LineageList output={o} recipeName={recipeName} />
      </section>

      <PublishState output={o} canRequest={canWrite} onRequest={() => setPublishing(true)} />
      <TargetDiscussion scope="OUTPUT" targetId={o.output_id} />
      <PublishDialog projectId={projectId} output={o} open={publishing} onOpenChange={setPublishing} />
    </div>
  );
}
