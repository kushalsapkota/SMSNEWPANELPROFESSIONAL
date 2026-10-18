import { OrgDetailView } from "@/components/orgs/org-detail";

export const metadata = { title: "Resellers" };

export default function Page({ params }: { params: { id: string } }) {
  return <OrgDetailView orgId={params.id} kind="reseller" />;
}
