"use client";

import { useState } from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { cn } from "@/lib/utils";

/** Monospace code with a copy button. */
export function CodeBlock({ code, label, className }: { code: string; label?: string; className?: string }) {
  return (
    <div className={cn("relative rounded-md border bg-muted/40", className)}>
      {label ? <div className="border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">{label}</div> : null}
      <CopyButton value={code} label={label ? `Copy ${label}` : "Copy code"} className="absolute right-1.5 top-1.5 bg-background/80" />
      <pre className="overflow-x-auto p-3 pr-10 text-xs leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}

/** Same snippet in several languages, switched with a small segmented control. */
export function CodeTabs({ snippets, label }: { snippets: Array<{ lang: string; code: string }>; label: string }) {
  const [active, setActive] = useState(snippets[0]?.lang);
  const current = snippets.find((s) => s.lang === active) ?? snippets[0];
  return (
    <div className="space-y-2">
      <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label={label}>
        {snippets.map((s) => (
          <button
            key={s.lang}
            type="button"
            role="tab"
            aria-selected={s.lang === current.lang}
            className={cn(
              "rounded-sm px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground",
              s.lang === current.lang && "bg-muted font-medium text-foreground",
            )}
            onClick={() => setActive(s.lang)}
          >
            {s.lang}
          </button>
        ))}
      </div>
      <CodeBlock code={current.code} label={`${label} (${current.lang})`} />
    </div>
  );
}
