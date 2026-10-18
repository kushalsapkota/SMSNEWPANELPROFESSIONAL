"use client";

import { Menu } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useSession } from "@/lib/auth/session";
import { ROLE_LABEL } from "@/lib/nav";
import { BalanceChip } from "./balance-chip";
import { BrandMark, SidebarNav } from "./sidebar";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";

export function Header({ brand }: { brand: string }) {
  const { org, role } = useSession();
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-4">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
            <Menu />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 bg-sidebar p-0">
          <SheetHeader className="flex h-14 justify-center border-b px-4">
            <SheetTitle className="text-left">
              <BrandMark brand={brand} />
            </SheetTitle>
          </SheetHeader>
          <SidebarNav role={role} onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="md:hidden">
        <span className="font-semibold">{brand}</span>
      </div>

      <div className="hidden min-w-0 items-center gap-2 md:flex">
        <span className="truncate font-medium">{org.name}</span>
        <Badge variant="outline">{ROLE_LABEL[role]}</Badge>
      </div>

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        {role !== "SUPER_ADMIN" ? (
          <div className="hidden min-[400px]:block">
            <BalanceChip orgId={org.id} />
          </div>
        ) : null}
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
