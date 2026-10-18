import { CreateOrgDialog } from "@/components/orgs/create-org-dialog";
import { OrgsTable } from "@/components/orgs/orgs-table";
import { PageHeader } from "@/components/shared/page-header";

export const metadata = { title: "Clients" };

export default function Page() {
  return (
    <>
      <PageHeader
        title="Clients"
        description="Your customers. Control their channels, routes, rates and credit."
        actions={<CreateOrgDialog kind="client" />}
      />
      <OrgsTable kind="client" />
    </>
  );
}
