import { OutputDetail } from "@/features/workspace/output-detail";

export default async function ProjectOutputPage({ params }: { params: Promise<{ outputId: string }> }) {
  const { outputId } = await params;
  return <OutputDetail outputId={outputId} />;
}
