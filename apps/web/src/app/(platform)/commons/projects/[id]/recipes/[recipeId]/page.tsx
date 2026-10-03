import { RecipeEditor } from "@/features/workspace/recipe-editor";

export default async function ProjectRecipePage({ params }: { params: Promise<{ recipeId: string }> }) {
  const { recipeId } = await params;
  return <RecipeEditor recipeId={recipeId} />;
}
