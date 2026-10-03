import { usePathname } from "next/navigation";
import { ProjectNotesTab } from "@/features/notes/project-notes-tab";
import { DiscussionTab } from "@/features/workspace/discussion-tab";
import { InputsTab } from "@/features/workspace/inputs-tab";
import { WorkspaceActivity, WorkspaceMembers } from "@/features/workspace/members-activity";
import { OutputDetail } from "@/features/workspace/output-detail";
import { OutputsTab } from "@/features/workspace/outputs-tab";
import { OverviewTab } from "@/features/workspace/overview-tab";
import { RecipeEditor } from "@/features/workspace/recipe-editor";
import { RecipesTab } from "@/features/workspace/recipes-tab";
import { WorkspaceLayout } from "@/features/workspace/workspace-layout";
import { renderScreen } from "./render";

/** The project workspace routes (app/(platform)/commons/projects/[id]/**) picked from the mocked pathname, like the app router. */
function WorkspaceRoutes({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const [tab, id] = pathname.slice(`/commons/projects/${projectId}`.length).split("/").filter(Boolean);
  const page =
    tab === "data" ? <InputsTab />
    : tab === "recipes" ? (id ? <RecipeEditor recipeId={id} /> : <RecipesTab />)
    : tab === "outputs" ? (id ? <OutputDetail outputId={id} /> : <OutputsTab />)
    : tab === "notes" ? <ProjectNotesTab />
    : tab === "discussion" ? <DiscussionTab />
    : tab === "members" ? <WorkspaceMembers />
    : tab === "activity" ? <WorkspaceActivity />
    : <OverviewTab />;
  return <WorkspaceLayout projectId={projectId}>{page}</WorkspaceLayout>;
}

/** Render a project workspace page at `path` (/commons/projects/{id}[/tab[/id]][?query]); Back/Forward via setLocation. */
export function renderWorkspace(path: string, user: string) {
  const projectId = new URL(path, "http://localhost").pathname.split("/")[3]!;
  return renderScreen(<WorkspaceRoutes projectId={projectId} />, { user, path });
}
