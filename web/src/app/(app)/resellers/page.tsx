import { CreateOrgDialog } from "@/components/orgs/create-org-dialog";
import { OrgsTable } from "@/components/orgs/orgs-table";
import { PageHeader } from "@/components/shared/page-header";

export const metadata = { title: "Resellers" };

export default function Page() {
  return (
    <>
      <PageHeader
        title="Resellers"
        description="Wholesale accounts. Each reseller manages its own clients, rates and branding."
        actions={<CreateOrgDialog kind="reseller" />}
      />
      <OrgsTable kind="reseller" />
    </>
  );
}
