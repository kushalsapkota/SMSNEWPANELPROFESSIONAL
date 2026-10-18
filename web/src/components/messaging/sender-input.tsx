"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, qk } from "@/lib/api";
import type { SenderId } from "@/lib/api/types";
import { isValidSender } from "@/lib/phone";

const OTHER = "__other__";

/** Normalized compare per engine rule: alnum case-insensitive, numeric ignoring "+". */
export function senderMatches(a: string, b: string): boolean {
  const num = /^\+?[0-9]+$/;
  if (num.test(a) && num.test(b)) return a.replace(/^\+/, "") === b.replace(/^\+/, "");
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Sender IDs of the acting org (all statuses: any row makes the org "restricted"). */
export function useSenderIds() {
  const params = { page_size: 200 } as const;
  const q = useQuery({
    queryKey: qk.senderIds.list(params),
    queryFn: () => api.senderIds.list(params),
    staleTime: 60_000,
  });
  return useMemo(() => {
    const all: SenderId[] = q.data?.items ?? [];
    const approved = all.filter((s) => s.status === "APPROVED");
    return { all, approved, restricted: all.length > 0, isLoading: q.isLoading };
  }, [q.data, q.isLoading]);
}

/**
 * Sender picker. If the account has approved sender IDs they're offered in a
 * select (the engine only accepts approved ones once any row exists), with an
 * "Other" escape for free text. Without sender IDs it's a free-text field.
 */
export function SenderInput({
  value,
  onChange,
  routeId,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  /** only senders approved for this route (or any route) are offered */
  routeId?: string;
  error?: string | null;
}) {
  const id = useId();
  const s = useSenderIds();
  const options = s.approved.filter((x) => !routeId || !x.route_id || x.route_id === routeId);
  const inList = options.some((o) => senderMatches(o.sender, value));
  const selectValue = options.length === 0 ? OTHER : inList ? options.find((o) => senderMatches(o.sender, value))!.sender : OTHER;
  const validity = value === "" ? null : isValidSender(value) ? null : "Up to 11 letters/digits or up to 15 digits";
  const notApproved = s.restricted && value !== "" && !inList;
  const shownError = error ?? validity;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Sender</Label>
      {options.length > 0 ? (
        <Select value={selectValue} onValueChange={(v) => onChange(v === OTHER ? "" : v)}>
          <SelectTrigger id={id}>
            <SelectValue placeholder="Pick a sender" />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.id} value={o.sender}>
                {o.sender}
                {o.route_id ? ` · ${o.route_name ?? "route-specific"}` : ""}
              </SelectItem>
            ))}
            <SelectItem value={OTHER}>Other (type below)</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
      {selectValue === OTHER ? (
        <Input
          id={options.length > 0 ? `${id}-text` : id}
          aria-label={options.length > 0 ? "Custom sender" : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="MYBRAND or 14155550100"
          maxLength={16}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          aria-invalid={!!shownError || undefined}
        />
      ) : null}
      {shownError ? (
        <p className="text-[0.8rem] font-medium text-destructive">{shownError}</p>
      ) : notApproved ? (
        <p className="text-[0.8rem] text-warning">
          Not an approved sender ID: the gateway will reject it (SENDER_NOT_ALLOWED).{" "}
          <Link href="/sender-ids" className="underline">
            Request it
          </Link>
          .
        </p>
      ) : (
        <p className="text-[0.8rem] text-muted-foreground">
          {s.restricted ? "Only approved sender IDs are accepted." : "Alphanumeric (≤11, with a letter), a long number or a short code."}
        </p>
      )}
    </div>
  );
}
