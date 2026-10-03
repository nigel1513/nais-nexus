import type { ReactNode } from "react";
import { WorkspaceLayout } from "@/features/workspace/workspace-layout";

export default async function ProjectWorkspaceLayout({ params, children }: { params: Promise<{ id: string }>; children: ReactNode }) {
  const { id } = await params;
  return <WorkspaceLayout projectId={id}>{children}</WorkspaceLayout>;
}
