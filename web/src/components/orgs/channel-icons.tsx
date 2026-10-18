import { Ban, Globe, Plug, Send } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Org } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const items = [
  { key: "sending_enabled", label: "Sending", icon: Send },
  { key: "api_enabled", label: "HTTP API", icon: Globe },
  { key: "smpp_enabled", label: "SMPP", icon: Plug },
  { key: "web_enabled", label: "Web panel", icon: Globe },
] as const;

/** Compact on/off indicators for the four channel flags. */
export function ChannelIcons({ org }: { org: Pick<Org, (typeof items)[number]["key"]> }) {
  return (
    <div className="flex items-center gap-1.5">
      {items.map(({ key, label, icon: Icon }) => {
        const on = org[key];
        return (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className={cn(
                  "relative inline-flex h-6 w-6 items-center justify-center rounded border",
                  on ? "border-success/40 text-success" : "border-muted text-muted-foreground/60",
                )}
                aria-label={`${label}: ${on ? "on" : "off"}`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {!on ? <Ban className="absolute h-5 w-5 opacity-60" aria-hidden /> : null}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {label}: {on ? "on" : "off"}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
