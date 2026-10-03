"use client";
import { Button, Checkbox, Switch } from "@nais/ui";
import { NotebookPen } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { useWorkspace } from "@/features/workspace/workspace-layout";
import { useListProjectMembers } from "@/features/projects/api";
import { useErrorText } from "@/shared/api/use-error-text";
import { DelayedSkeleton } from "@/shared/ui/state-views";
import { notify } from "@/shared/ui/toast";
import { PanelHead } from "@/shared/ui/work-hero";
import { useNoteSettings, useTodayNote, useUpdateNoteSettings } from "./api";
import { ExportRangeButton } from "./export-button";
import { NoteTable } from "./note-table";

/**
 * 연구노트 tab of a project workspace: 오늘 노트 쓰기, my notes in this project, the notes waiting for me as witness,
 * export, and (owner / admin) the witness rule.
 */
export function ProjectNotesTab() {
  const t = useTranslations();
  const { project, manager, archived, navigate } = useWorkspace();
  const projectId = project.project_id;
  const member = !!project.my_role && !archived;
  const today = useTodayNote();
  const errorText = useErrorText();
  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="ws-notes">
        <PanelHead
          id="ws-notes"
          crumb={t("workspace.tabs.notes")}
          title={t("notes.mine")}
          className="mb-3"
          right={
            <>
              <ExportRangeButton projectId={projectId} />
              {member ? (
                <Button
                  variant="primary"
                  loading={today.isPending}
                  onClick={() =>
                    today.mutate(projectId, {
                      onSuccess: (n) => navigate(`/commons/notes/${n.note_id}`),
                      onError: (e) => notify.error(errorText(e)),
                    })
                  }
                >
                  <NotebookPen aria-hidden="true" strokeWidth={1.75} />
                  {t("notes.today")}
                </Button>
              ) : null}
            </>
          }
        />
        <NoteTable query={{ role: "recorder", project_id: projectId }} caption={t("notes.mine")} showProject={false} />
      </section>
      <section aria-labelledby="ws-notes-witness">
        <PanelHead id="ws-notes-witness" crumb={t("workspace.tabs.notes")} title={t("notes.tab.witness")} className="mb-3" />
        <NoteTable query={{ role: "witness", project_id: projectId }} caption={t("notes.witness")} showProject={false} />
      </section>
      {manager ? <WitnessSettings projectId={projectId} /> : null}
    </div>
  );
}

function WitnessSettings({ projectId }: { projectId: string }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const headingId = useId();
  const settings = useNoteSettings(projectId);
  const members = useListProjectMembers(projectId);
  const update = useUpdateNoteSettings(projectId);
  const [required, setRequired] = useState(false);
  const [witnesses, setWitnesses] = useState<string[]>([]);
  useEffect(() => {
    if (!settings.data) return;
    setRequired(settings.data.witness_required);
    setWitnesses(settings.data.witness_user_ids);
  }, [settings.data]);
  return (
    <section aria-labelledby={headingId}>
      <PanelHead id={headingId} crumb={t("notes.settings.kicker")} title={t("notes.settings.title")} className="mb-3" />
      {settings.isPending || members.isPending ? (
        <DelayedSkeleton />
      ) : (
        <form
          className="flex max-w-2xl flex-col gap-4 rounded-md border border-border bg-bg-panel p-4"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ witness_required: required, witness_user_ids: witnesses }, { onSuccess: () => notify.success(t("notes.settings.saved")) });
          }}
        >
          <div className="flex flex-col gap-1">
            <Switch checked={required} onCheckedChange={setRequired} label={t("notes.settings.required")} />
            <p className="text-small text-fg-muted">{t("notes.settings.hint")}</p>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-small font-medium text-fg">{t("notes.settings.witnesses")}</legend>
            {(members.data?.items ?? []).map((m) => (
              <label key={m.user_id} className="flex items-center gap-2 text-body text-fg">
                <Checkbox
                  checked={witnesses.includes(m.user_id)}
                  onChange={(e) => setWitnesses((ws) => (e.target.checked ? [...ws, m.user_id] : ws.filter((w) => w !== m.user_id)))}
                />
                <span className="break-keep">
                  {m.display_name ?? m.user_id}
                  {m.organization_name ? <span className="text-fg-muted"> · {m.organization_name}</span> : null}
                </span>
              </label>
            ))}
          </fieldset>
          {update.isError ? (
            <p role="alert" className="text-small text-danger">
              {errorText(update.error)}
            </p>
          ) : null}
          <div>
            <Button type="submit" variant="primary" loading={update.isPending}>
              {t("notes.settings.save")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
