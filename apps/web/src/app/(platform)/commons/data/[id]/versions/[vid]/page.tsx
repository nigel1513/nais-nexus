import { VersionDetailScreen } from "@/features/catalog/version-detail-screen";

export default async function VersionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; vid: string }>;
  searchParams: Promise<{ download?: string }>;
}) {
  const [{ id, vid }, { download }] = await Promise.all([params, searchParams]);
  return <VersionDetailScreen datasetId={id} versionId={vid} focusDownload={download === "1"} />;
}
