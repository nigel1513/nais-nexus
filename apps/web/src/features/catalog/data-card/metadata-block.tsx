"use client";
import { Button } from "@nais/ui";
import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, type ReactNode } from "react";
import type { Dataset } from "@/shared/api/types";
import { notify } from "@/shared/ui/toast";
import { downloadJsonLd } from "../api";
import { PersonLine } from "../components/person-line";
import { VocabularyTags } from "../components/vocabulary-tags";
import { PanelHead } from "@/shared/ui/work-hero";
import "@/shared/ui/screen-v2.css";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-fg [text-wrap:pretty] max-sm:mb-2">{children}</dd>
    </div>
  );
}

/** One metadata group: accent crumb label over a label / value list. Groups sit in one bordered grid, split by 1px rules. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3 bg-bg-panel px-5 py-4 xl:[&:last-child:nth-child(odd)]:col-span-2">
      <h3 id={id} className="sv-kicker">
        {title}
      </h3>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-small sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-y-2.5">{children}</dl>
    </section>
  );
}

export function JsonLdButton({ dataset }: { dataset: Pick<Dataset, "dataset_id" | "title"> }) {
  const t = useTranslations();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        downloadJsonLd(dataset.dataset_id, dataset.title).catch(() => notify.error(t("data.card.jsonldFailed")));
      }}
    >
      <Download aria-hidden="true" strokeWidth={1.75} />
      {t("data.card.jsonld")}
    </Button>
  );
}

export function MetadataBlock({ dataset: d }: { dataset: Dataset }) {
  const t = useTranslations();
  const pi = d.people?.principal_investigator;
  const contributors = d.people?.contributors ?? [];
  const subjects = d.subject_codes ?? [];
  const methods = d.method_codes ?? [];
  const materials = d.material_codes ?? [];
  const papers = d.related_publications ?? [];
  const period = d.temporal_start ? `${d.temporal_start} – ${d.temporal_end ?? t("data.meta.ongoing")}` : null;
  const people = [
    pi ? (
      <Row key="pi" label={t("data.meta.pi")}>
        <PersonLine person={pi} />
      </Row>
    ) : null,
    ...contributors.map((c) => (
      <Row key={`${c.user_id}-${c.role}`} label={t(`enums.ContributorRole.${c.role}`)}>
        <PersonLine person={c} />
      </Row>
    )),
    d.contact_email ? (
      <Row key="mail" label={t("data.meta.legacyContact")}>
        {d.contact_email}
      </Row>
    ) : null,
  ].filter(Boolean);
  const context = [
    subjects.length ? (
      <Row key="s" label={t("data.meta.subjects")}>
        <VocabularyTags scheme="SUBJECT" codes={subjects} />
      </Row>
    ) : null,
    d.project_title ? (
      <Row key="p" label={t("data.meta.project")}>
        {d.project_code ? `${d.project_title} (${d.project_code})` : d.project_title}
      </Row>
    ) : null,
    d.funding_agency ? (
      <Row key="f" label={t("data.meta.funding")}>
        {d.funding_agency}
      </Row>
    ) : null,
    papers.length ? (
      <Row key="pub" label={t("data.meta.publications")}>
        <ul className="flex flex-col gap-1">
          {papers.map((p) => {
            const href = p.doi ? `https://doi.org/${p.doi}` : p.url;
            return (
              <li key={`${p.title}-${p.doi ?? p.url ?? ""}`}>
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-fg underline-offset-4 hover:underline">
                    {p.title}
                  </a>
                ) : (
                  p.title
                )}
              </li>
            );
          })}
        </ul>
      </Row>
    ) : null,
  ].filter(Boolean);
  const collection = [
    d.collecting_organization?.name ? (
      <Row key="org" label={t("data.meta.collectingOrg")}>
        {d.collecting_organization.name}
      </Row>
    ) : null,
    period ? (
      <Row key="period" label={t("data.meta.period")}>
        <span className="num">{period}</span>
      </Row>
    ) : null,
    methods.length || d.method_detail ? (
      <Row key="m" label={t("data.meta.methods")}>
        <span className="flex flex-col gap-1.5">
          {methods.length ? <VocabularyTags scheme="METHOD" codes={methods} /> : null}
          {d.method_detail ? <span>{d.method_detail}</span> : null}
        </span>
      </Row>
    ) : null,
    materials.length ? (
      <Row key="mat" label={t("data.meta.materials")}>
        <VocabularyTags scheme="MATERIAL" codes={materials} />
      </Row>
    ) : null,
    d.provenance ? (
      <Row key="prov" label={t("data.meta.provenance")}>
        {d.provenance}
      </Row>
    ) : null,
  ].filter(Boolean);
  return (
    <section aria-label={t("data.meta.title")} className="flex flex-col gap-4">
      <PanelHead crumb={t("data.card.hero.metaCrumb")} title={t("data.meta.title")} />
      <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border xl:grid-cols-2">
        {people.length ? <Group title={t("data.meta.groups.people")}>{people}</Group> : null}
        {context.length ? <Group title={t("data.meta.groups.context")}>{context}</Group> : null}
        {collection.length ? <Group title={t("data.meta.groups.collection")}>{collection}</Group> : null}
        <Group title={t("data.meta.groups.use")}>
          <Row label={t("data.meta.license")}>
            <span className="font-mono text-mono">{d.license}</span>
          </Row>
          {d.usage_policy ? <Row label={t("data.meta.usagePolicy")}>{d.usage_policy}</Row> : null}
          {d.update_frequency ? <Row label={t("data.meta.updateFrequency")}>{t(`enums.UpdateFrequency.${d.update_frequency}`)}</Row> : null}
          <Row label={t("data.meta.export")}>
            <span className="-my-1 -ml-2.5 inline-flex">
              <JsonLdButton dataset={d} />
            </span>
          </Row>
        </Group>
      </div>
    </section>
  );
}
