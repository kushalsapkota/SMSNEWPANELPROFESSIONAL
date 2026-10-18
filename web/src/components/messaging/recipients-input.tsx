"use client";

import { FileUp, Sparkles } from "lucide-react";
import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { parseCsv, findPhoneColumn } from "@/lib/csv";
import { readFileText } from "@/lib/download";
import { formatNumber } from "@/lib/format";
import { parseRecipients } from "@/lib/phone";

export interface RecipientStats {
  valid: string[];
  invalid: string[];
  /** entries before de-duplication */
  entries: number;
  duplicates: number;
}

export function recipientStats(text: string): RecipientStats {
  const { valid, invalid } = parseRecipients(text);
  const entries = text.split(/[\n,;]+/).filter((t) => t.trim()).length;
  return { valid, invalid, entries, duplicates: Math.max(0, entries - valid.length - invalid.length) };
}

/**
 * Paste-many recipients box: newline / comma / semicolon separated, numbers
 * normalized to digits (CONTRACTS §3), de-duplicated live, invalid entries
 * listed. "Clean up" rewrites the box to the normalized unique list.
 */
export function RecipientsInput({
  value,
  onChange,
  stats,
  max,
  label = "Recipients",
}: {
  value: string;
  onChange: (v: string) => void;
  stats: RecipientStats;
  max?: number;
  label?: string;
}) {
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const over = max !== undefined && stats.valid.length > max;

  const importFile = async (file: File) => {
    const text = await readFileText(file);
    let numbers: string[];
    const csv = parseCsv(text);
    const col = findPhoneColumn(csv.headers);
    if (col) {
      const i = csv.headers.indexOf(col);
      numbers = csv.rows.map((r) => r[i] ?? "");
    } else {
      // plain list (one number per line, or first column)
      numbers = text.split(/\r?\n/).map((l) => l.split(/[,;\t]/)[0] ?? "");
    }
    const joined = [value.trim(), ...numbers.map((n) => n.trim()).filter(Boolean)].filter(Boolean).join("\n");
    onChange(joined);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
            <FileUp aria-hidden /> Import
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="hidden"
            aria-label="Import recipients from a file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={stats.duplicates === 0 && stats.invalid.length === 0 && stats.entries === stats.valid.length}
            onClick={() => onChange(stats.valid.join("\n"))}
          >
            <Sparkles aria-hidden /> Clean up
          </Button>
        </div>
      </div>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={6}
        spellCheck={false}
        placeholder={"+91 98765 43210\n14155550100, 447700900123"}
        className="font-mono text-sm"
        aria-describedby={`${id}-stats`}
        aria-invalid={over || undefined}
      />
      <div id={`${id}-stats`} className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-live="polite">
        <span className={over ? "font-semibold text-destructive" : "font-medium text-foreground"}>
          {formatNumber(stats.valid.length)} unique {stats.valid.length === 1 ? "number" : "numbers"}
          {max !== undefined ? ` (max ${formatNumber(max)})` : ""}
        </span>
        {stats.duplicates > 0 ? <span>{formatNumber(stats.duplicates)} duplicates removed</span> : null}
        {stats.invalid.length > 0 ? (
          <span className="text-destructive">
            {formatNumber(stats.invalid.length)} invalid: {stats.invalid.slice(0, 5).join(", ")}
            {stats.invalid.length > 5 ? "…" : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}
