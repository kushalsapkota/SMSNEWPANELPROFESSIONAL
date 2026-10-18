"use client";

import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDebouncedValue } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";

/** Debounced search box for table toolbars. */
export function SearchFilter({
  value,
  onChange,
  placeholder = "Search…",
  className,
  label = "Search",
  maxLength,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  placeholder?: string;
  className?: string;
  label?: string;
  maxLength?: number;
}) {
  const [text, setText] = useState(value ?? "");
  const debounced = useDebouncedValue(text, 350);
  useEffect(() => {
    setText(value ?? "");
  }, [value]);
  useEffect(() => {
    if ((debounced || undefined) !== (value || undefined)) onChange(debounced || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  return (
    <div className={cn("relative w-full sm:w-64", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
      <Input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={text}
        maxLength={maxLength}
        onChange={(e) => setText(e.target.value)}
        className="pl-8"
      />
    </div>
  );
}

const ALL = "__all__";

/** Select filter with an "All" option mapping to undefined. */
export function SelectFilter({
  value,
  onChange,
  options,
  allLabel = "All",
  label,
  className,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  options: Array<{ value: string; label: string }>;
  allLabel?: string;
  label: string;
  className?: string;
}) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger className={cn("w-full sm:w-44", className)} aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ResetFiltersButton({ onClick, visible }: { onClick: () => void; visible: boolean }) {
  if (!visible) return null;
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      <X /> Reset
    </Button>
  );
}
