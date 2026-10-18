"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiKeysPanel, IpWhitelistPanel, SmppAccountsPanel, WebhooksPanel } from "@/components/credentials";
import { PageHeader } from "@/components/shared/page-header";
import { useTabParam } from "@/hooks/use-tab-param";
import { ApiDocs } from "./api-docs";
import { SmppConnectionInfo } from "./smpp-connection-info";

const TABS = ["keys", "smpp", "ip", "webhooks", "docs"] as const;

/** Client "API & SMPP" page: credentials of the acting org + integration docs. */
export function DeveloperPage() {
  const [tab, setTab] = useTabParam(TABS, "keys");
  return (
    <>
      <PageHeader title="API & SMPP" description="Credentials and documentation for integrating with the gateway." />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="keys">API keys</TabsTrigger>
          <TabsTrigger value="smpp">SMPP</TabsTrigger>
          <TabsTrigger value="ip">IP whitelist</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
          <TabsTrigger value="docs">API docs</TabsTrigger>
        </TabsList>
        <TabsContent value="keys" className="mt-4">
          <ApiKeysPanel />
        </TabsContent>
        <TabsContent value="smpp" className="mt-4 space-y-6">
          <SmppAccountsPanel />
          <SmppConnectionInfo />
        </TabsContent>
        <TabsContent value="ip" className="mt-4">
          <IpWhitelistPanel />
        </TabsContent>
        <TabsContent value="webhooks" className="mt-4">
          <WebhooksPanel />
        </TabsContent>
        <TabsContent value="docs" className="mt-4">
          <ApiDocs />
        </TabsContent>
      </Tabs>
    </>
  );
}
