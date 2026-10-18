"use client";

import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CopyField } from "@/components/shared/copy-button";

/** Shows a one-time secret (API key, webhook secret) with copy + warning. */
export function SecretRevealDialog({
  secret,
  title,
  description,
  onClose,
}: {
  secret: string | null;
  title: string;
  description?: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!secret} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Copy it now — it is shown only once and can&apos;t be retrieved later.
          </AlertDescription>
        </Alert>
        {secret ? <CopyField value={secret} /> : null}
        <DialogFooter>
          <Button onClick={onClose}>I&apos;ve saved it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
