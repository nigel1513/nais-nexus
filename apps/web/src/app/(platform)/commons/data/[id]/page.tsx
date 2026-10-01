import { DatasetDetailScreen } from "@/features/catalog/dataset-detail-screen";

export default async function DatasetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const [{ id }, { created }] = await Promise.all([params, searchParams]);
  return <DatasetDetailScreen datasetId={id} created={created === "1"} />;
}
