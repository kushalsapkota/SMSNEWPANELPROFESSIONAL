"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({
  value,
  label = "Copy",
  className,
  size = "icon",
  variant = "ghost",
  showLabel = false,
}: {
  value: string;
  label?: string;
  className?: string;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  showLabel?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    if (await writeClipboard(value)) {
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error("Couldn't copy — select the text and copy manually");
    }
  };
  const icon = copied ? <Check aria-hidden /> : <Copy aria-hidden />;
  const button = (
    <Button
      type="button"
      size={showLabel ? "sm" : size}
      variant={variant}
      className={cn(!showLabel && "h-7 w-7", className)}
      onClick={onClick}
      aria-label={label}
    >
      {icon}
      {showLabel ? label : null}
    </Button>
  );
  if (showLabel) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Monospace value with an inline copy button. */
export function CopyField({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-1 rounded-md border bg-muted/40 pl-3", className)}>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-2 font-mono text-sm">
        {value}
      </code>
      <CopyButton value={value} className="mr-1" />
    </div>
  );
}
