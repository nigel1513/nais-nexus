"use client";
import { useListAuditEvents } from "@/features/audit/api";
import { AuditTimeline } from "@/features/audit/components/audit-timeline";
import { MembersTab } from "@/features/projects/components/members-tab";
import { useWorkspace } from "./workspace-layout";

/** 구성원: invite, change roles, remove, leave (the former project detail's members tab). */
export function WorkspaceMembers() {
  const { project, manager } = useWorkspace();
  return <MembersTab project={project} manager={manager} />;
}

/** 활동: the project's audit trail. */
export function WorkspaceActivity() {
  const { project } = useWorkspace();
  const activity = useListAuditEvents({ project_id: project.project_id });
  return <AuditTimeline query={activity} />;
}
