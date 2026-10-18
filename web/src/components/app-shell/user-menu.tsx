"use client";

import { LogOut, Settings, ShieldCheck, Undo2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorMessage } from "@/lib/api";
import { useAuth, useSession } from "@/lib/auth/session";
import { ROLE_LABEL } from "@/lib/nav";

function initials(nameOrEmail: string): string {
  const parts = nameOrEmail.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function UserMenu() {
  const { user, org, impersonating, role } = useSession();
  const { logout, stopImpersonation } = useAuth();
  const display = user.full_name || user.email;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 gap-2 px-1.5" aria-label="Account menu">
          <Avatar className="h-7 w-7">
            <AvatarFallback className="text-xs">{initials(display)}</AvatarFallback>
          </Avatar>
          <span className="hidden max-w-[10rem] truncate text-sm lg:inline">{display}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="space-y-0.5 font-normal">
          <div className="truncate text-sm font-medium">{display}</div>
          <div className="truncate text-xs text-muted-foreground">{user.email}</div>
          <div className="truncate text-xs text-muted-foreground">
            {org.name} · {ROLE_LABEL[role]}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings className="mr-2 h-4 w-4" /> Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings?tab=security">
            <ShieldCheck className="mr-2 h-4 w-4" /> Security &amp; 2FA
          </Link>
        </DropdownMenuItem>
        {impersonating ? (
          <DropdownMenuItem
            onSelect={() =>
              stopImpersonation().catch((e) =>
                toast.error("Couldn't return to your account", { description: errorMessage(e) }),
              )
            }
          >
            <Undo2 className="mr-2 h-4 w-4" /> Return to my account
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void logout()}>
          <LogOut className="mr-2 h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
