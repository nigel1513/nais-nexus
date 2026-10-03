import { CompareScreen } from "@/features/catalog/versions/compare-screen";

/** Static segment: wins over the sibling `[vid]` route, so /versions/compare never reads as a version id. */
export default async function CompareVersionsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ to?: string; from?: string }> }) {
  const [{ id }, { to, from }] = await Promise.all([params, searchParams]);
  return <CompareScreen datasetId={id} to={to} from={from} />;
}
