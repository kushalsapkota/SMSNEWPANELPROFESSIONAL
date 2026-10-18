import { ConnectionDetail } from "@/components/connections/connection-detail";

export const metadata = { title: "Connection" };

export default function Page({ params }: { params: { id: string } }) {
  return <ConnectionDetail id={params.id} />;
}
