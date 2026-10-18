"use client";

import { Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface ConfirmDialogProps {
  /** Element that opens the dialog (uncontrolled). */
  trigger?: ReactNode;
  /** Controlled mode. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  /** Ask for a free-text reason (e.g. suspend). Passed to onConfirm. */
  reason?: { label: string; placeholder?: string; required?: boolean };
  /** Require typing this exact text to enable confirm (high-risk deletes). */
  confirmText?: string;
  /** Resolve to close; throw to keep open (error toast is the caller's job). */
  onConfirm: (reason: string) => unknown | Promise<unknown>;
}

/** Confirmation for destructive / irreversible actions. */
export function ConfirmDialog({
  trigger,
  open: openProp,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  destructive = true,
  reason,
  confirmText,
  onConfirm,
}: ConfirmDialogProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const [busy, setBusy] = useState(false);
  const [reasonText, setReasonText] = useState("");
  const [typed, setTyped] = useState("");

  const setOpen = (v: boolean) => {
    if (busy) return;
    if (!v) {
      setReasonText("");
      setTyped("");
    }
    setOpenState(v);
    onOpenChange?.(v);
  };

  const blocked =
    (reason?.required !== false && !!reason && reasonText.trim() === "") ||
    (!!confirmText && typed !== confirmText);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm(reasonText.trim());
      setBusy(false);
      setOpen(false);
    } catch {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription asChild><div>{description}</div></AlertDialogDescription> : null}
        </AlertDialogHeader>
        {reason ? (
          <div className="space-y-2">
            <Label htmlFor="confirm-reason">{reason.label}</Label>
            <Textarea
              id="confirm-reason"
              value={reasonText}
              placeholder={reason.placeholder}
              onChange={(e) => setReasonText(e.target.value)}
              rows={3}
            />
          </div>
        ) : null}
        {confirmText ? (
          <div className="space-y-2">
            <Label htmlFor="confirm-text">
              Type <span className="font-mono font-semibold">{confirmText}</span> to confirm
            </Label>
            <Input id="confirm-text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={confirm}
            disabled={busy || blocked}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
