"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/shared/page-header";
import { useTabParam } from "@/hooks/use-tab-param";
import { useSession } from "@/lib/auth/session";
import { BrandingCard } from "./branding-card";
import { NotificationsCard } from "./notifications-card";
import { PasswordCard } from "./password-card";
import { ProfileCard } from "./profile-card";
import { TotpCard } from "./totp-card";

const ALL_TABS = ["profile", "security", "branding", "notifications"] as const;

export function SettingsPage() {
  const { role } = useSession();
  const tabs = ALL_TABS.filter((t) => t !== "branding" || role === "RESELLER");
  const [tab, setTab] = useTabParam(tabs, "profile");
  return (
    <>
      <PageHeader title="Settings" description="Your profile, security and preferences." />
      <Tabs value={tab} onValueChange={setTab}>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList className="w-max">
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
            {role === "RESELLER" ? <TabsTrigger value="branding">Branding</TabsTrigger> : null}
            <TabsTrigger value="notifications">Notifications</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="profile" className="mt-6">
          <ProfileCard />
        </TabsContent>
        <TabsContent value="security" className="mt-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <PasswordCard />
            <TotpCard />
          </div>
        </TabsContent>
        {role === "RESELLER" ? (
          <TabsContent value="branding" className="mt-6">
            <div className="max-w-2xl">
              <BrandingCard />
            </div>
          </TabsContent>
        ) : null}
        <TabsContent value="notifications" className="mt-6">
          <div className="max-w-2xl">
            <NotificationsCard />
          </div>
        </TabsContent>
      </Tabs>
    </>
  );
}
