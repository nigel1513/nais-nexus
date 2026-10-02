"use client";
import { Button } from "@nais/ui";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Dataset } from "@/shared/api/types";
import { notify } from "@/shared/ui/toast";
import { downloadJsonLd } from "../api";
import { PersonLine } from "../components/person-line";
import { VocabularyTags } from "../components/vocabulary-tags";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words">{children}</dd>
    </>
  );
}

export function JsonLdButton({ dataset }: { dataset: Pick<Dataset, "dataset_id" | "title"> }) {
  const t = useTranslations();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        downloadJsonLd(dataset.dataset_id, dataset.title).catch(() => notify.error(t("data.card.jsonldFailed")));
      }}
    >
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
  return (
    <section aria-label={t("data.meta.title")}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t("data.meta.title")}</h2>
        <JsonLdButton dataset={d} />
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
        {pi ? (
          <Row label={t("data.meta.pi")}>
            <PersonLine person={pi} />
          </Row>
        ) : null}
        {contributors.map((c) => (
          <Row key={`${c.user_id}-${c.role}`} label={t(`enums.ContributorRole.${c.role}`)}>
            <PersonLine person={c} />
          </Row>
        ))}
        {d.collecting_organization?.name ? <Row label={t("data.meta.collectingOrg")}>{d.collecting_organization.name}</Row> : null}
        {period ? <Row label={t("data.meta.period")}>{period}</Row> : null}
        {subjects.length ? (
          <Row label={t("data.meta.subjects")}>
            <VocabularyTags scheme="SUBJECT" codes={subjects} />
          </Row>
        ) : null}
        {methods.length ? (
          <Row label={t("data.meta.methods")}>
            <VocabularyTags scheme="METHOD" codes={methods} />
          </Row>
        ) : null}
        {materials.length ? (
          <Row label={t("data.meta.materials")}>
            <VocabularyTags scheme="MATERIAL" codes={materials} />
          </Row>
        ) : null}
        {d.project_title ? <Row label={t("data.meta.project")}>{d.project_code ? `${d.project_title} (${d.project_code})` : d.project_title}</Row> : null}
        {d.funding_agency ? <Row label={t("data.meta.funding")}>{d.funding_agency}</Row> : null}
        {d.method_detail ? <Row label={t("data.meta.methodDetail")}>{d.method_detail}</Row> : null}
        {d.provenance ? <Row label={t("data.meta.provenance")}>{d.provenance}</Row> : null}
        <Row label={t("data.meta.license")}>{d.license}</Row>
        {d.usage_policy ? <Row label={t("data.meta.usagePolicy")}>{d.usage_policy}</Row> : null}
        {d.update_frequency ? <Row label={t("data.meta.updateFrequency")}>{t(`enums.UpdateFrequency.${d.update_frequency}`)}</Row> : null}
        {papers.length ? (
          <Row label={t("data.meta.publications")}>
            <ul className="flex flex-col gap-1">
              {papers.map((p) => {
                const href = p.doi ? `https://doi.org/${p.doi}` : p.url;
                return (
                  <li key={`${p.title}-${p.doi ?? p.url ?? ""}`}>
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
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
        ) : null}
        {d.contact_email ? <Row label={t("data.meta.legacyContact")}>{d.contact_email}</Row> : null}
      </dl>
    </section>
  );
}
