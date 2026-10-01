import { AccessRequestDetailScreen } from "@/features/governance/access-request-detail-screen";

export default async function AccessRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AccessRequestDetailScreen accessRequestId={id} />;
}
