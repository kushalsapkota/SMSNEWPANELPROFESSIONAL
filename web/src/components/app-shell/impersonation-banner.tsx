"use client";

import { Eye, Loader2, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { useAuth, useSession } from "@/lib/auth/session";
import { ROLE_LABEL } from "@/lib/nav";

export function ImpersonationBanner() {
  const { impersonating, org, original_org, role } = useSession();
  const { stopImpersonation } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!impersonating) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-warning px-4 py-2 text-sm text-warning-foreground"
    >
      <span className="inline-flex items-center gap-1.5">
        <Eye className="h-4 w-4" aria-hidden />
        You are logged in as <strong>{org.name}</strong> ({ROLE_LABEL[role]})
        {original_org ? <> from {original_org.name}</> : null}
      </span>
      <Button
        size="sm"
        variant="secondary"
        className="h-7"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await stopImpersonation();
            toast.success("Returned to your account");
          } catch (e) {
            toast.error("Couldn't return to your account", { description: errorMessage(e) });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader2 className="animate-spin" /> : <Undo2 />}
        Return to my account
      </Button>
    </div>
  );
}
