"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ApiKeysPanel,
  IpWhitelistPanel,
  SmppAccountsPanel,
  WebhooksPanel,
} from "@/components/credentials";
import { ApiDocs } from "@/components/developer/api-docs";
import { SmppConnectionInfo } from "@/components/developer/smpp-connection-info";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorState, FullPageSpinner } from "@/components/shared/states";
import { StatusBadge } from "@/components/shared/status-badge";
import { TemplatesTable } from "@/components/templates/templates-table";
import { useTabParam } from "@/hooks/use-tab-param";
import { api, qk } from "@/lib/api";
import { BalanceTab } from "./balance-tab";
import { ChannelsTab } from "./channels-tab";
import { KIND, type OrgKind } from "./kind";
import { DeleteOrgButton, LoginAsButton, SuspendActivateButton } from "./org-actions";
import { OrgsTable } from "./orgs-table";
import { OverviewTab } from "./overview-tab";
import { RoutesTab } from "./routes-tab";
import { UsersTab } from "./users-tab";

const RESELLER_TABS = ["overview", "channels", "balance", "routes", "users", "clients"] as const;
const CLIENT_TABS = ["overview", "channels", "balance", "routes", "users", "credentials", "templates"] as const;
type TabId = (typeof RESELLER_TABS)[number] | (typeof CLIENT_TABS)[number];

const LABEL: Record<TabId, string> = {
  overview: "Overview",
  channels: "Channels",
  balance: "Balance",
  routes: "Routes",
  users: "Users",
  clients: "Clients",
  credentials: "Credentials",
  templates: "Template overrides",
};

/**
 * Detail page for a child org: admin → reseller, reseller → client.
 * Tabs are URL-addressable (?tab=balance).
 */
export function OrgDetailView({ orgId, kind }: { orgId: string; kind: OrgKind }) {
  const k = KIND[kind];
  const tabs: readonly TabId[] = kind === "reseller" ? RESELLER_TABS : CLIENT_TABS;
  const [tab, setTab] = useTabParam<TabId>(tabs, "overview");
  const q = useQuery({ queryKey: qk.orgs.detail(orgId), queryFn: () => api.orgs.get(orgId) });

  if (q.isLoading) return <FullPageSpinner />;
  if (q.isError || !q.data) {
    return (
      <>
        <PageHeader title={k.singular} back={{ href: k.basePath, label: k.plural }} />
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      </>
    );
  }
  const org = q.data;

  return (
    <>
      <PageHeader
        back={{ href: k.basePath, label: k.plural }}
        title={org.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={org.status} />
            <Badge variant="outline">{k.singular}</Badge>
            {org.brand_name ? <span>· brand “{org.brand_name}”</span> : null}
          </span>
        }
        actions={
          <>
            <LoginAsButton org={org} />
            <SuspendActivateButton org={org} kind={kind} />
            <DeleteOrgButton org={org} kind={kind} />
          </>
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList className="w-max">
            {tabs.map((id) => (
              <TabsTrigger key={id} value={id}>
                {LABEL[id]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <div className="mt-6">
          <TabsContent value="overview">
            <OverviewTab org={org} kind={kind} />
          </TabsContent>
          <TabsContent value="channels">
            <ChannelsTab org={org} kind={kind} />
          </TabsContent>
          <TabsContent value="balance">
            <BalanceTab org={org} />
          </TabsContent>
          <TabsContent value="routes">
            <RoutesTab org={org} kind={kind} />
          </TabsContent>
          <TabsContent value="users">
            <UsersTab org={org} />
          </TabsContent>
          {kind === "reseller" ? (
            <TabsContent value="clients">
              <p className="mb-3 text-sm text-muted-foreground">
                Read-only. Use “Login as” to manage this reseller&apos;s clients.
              </p>
              <OrgsTable kind="client" parentId={org.id} linkRows={false} prefix="c" />
            </TabsContent>
          ) : (
            <>
              <TabsContent value="credentials" className="space-y-6">
                <ApiKeysPanel orgId={org.id} />
                <SmppAccountsPanel orgId={org.id} />
                <IpWhitelistPanel orgId={org.id} />
                <WebhooksPanel orgId={org.id} />
                <SmppConnectionInfo />
                <ApiDocs />
              </TabsContent>
              <TabsContent value="templates">
                <TemplatesTable clientId={org.id} />
              </TabsContent>
            </>
          )}
        </div>
      </Tabs>
    </>
  );
}
