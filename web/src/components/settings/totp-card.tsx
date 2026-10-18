"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Download, ShieldCheck, ShieldOff } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { CopyButton, CopyField } from "@/components/shared/copy-button";
import { SubmitButton, TextField } from "@/components/shared/form-fields";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import type { TotpSetupResponse } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";

const codeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") });
const disableSchema = z.object({
  code: z.string().trim().regex(/^(\d{6}|[A-Za-z0-9-]{8,20})$/, "6-digit code or a recovery code"),
});

function QrImage({ value }: { value: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { margin: 1, width: 220, errorCorrectionLevel: "M" })
      .then((url) => !cancelled && setSrc(url))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [value]);
  if (failed) return <p className="text-sm text-destructive">Couldn&apos;t render the QR code — enter the secret manually.</p>;
  if (!src) return <div className="h-[220px] w-[220px] animate-pulse rounded-md bg-muted" aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} width={220} height={220} alt="QR code for your authenticator app" className="rounded-md border bg-white p-2" />;
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join("\n");
  const download = () => {
    const blob = new Blob([`SMS Gateway recovery codes\n\n${text}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-4">
      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>Two-factor authentication is on</AlertTitle>
        <AlertDescription>
          Save these recovery codes somewhere safe. Each can be used once if you lose your device. They won&apos;t be shown again.
        </AlertDescription>
      </Alert>
      <ul className="grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-4 font-mono text-sm" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <CopyButton value={text} label="Copy all" showLabel variant="outline" />
        <Button variant="outline" size="sm" onClick={download}>
          <Download /> Download
        </Button>
        <Button size="sm" className="ml-auto" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function SetupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const form = useForm<z.infer<typeof codeSchema>>({ resolver: zodResolver(codeSchema), defaultValues: { code: "" } });

  const start = useApiMutation({
    mutationFn: () => api.auth.totpSetup(),
    success: false,
    onSuccess: (s) => setSetup(s),
  });
  const enable = useApiMutation({
    mutationFn: (v: z.infer<typeof codeSchema>) => api.auth.totpEnable({ code: v.code }),
    success: "Two-factor authentication enabled",
    invalidate: [qk.me],
    onSuccess: (r) => setCodes(r.recovery_codes),
    errorTitle: "Invalid code",
  });

  const { mutate: startMutate } = start;
  useEffect(() => {
    if (open) {
      setSetup(null);
      setCodes(null);
      form.reset();
      startMutate();
    }
  }, [open, form, startMutate]);

  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Set up two-factor authentication</DialogTitle>
          <DialogDescription>
            Scan the QR code with Google Authenticator, 1Password, Authy or any TOTP app.
          </DialogDescription>
        </DialogHeader>
        {codes ? (
          <RecoveryCodes codes={codes} onDone={close} />
        ) : !setup ? (
          <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
            {start.isError ? "Couldn't start setup." : "Generating secret…"}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex justify-center">
              <QrImage value={setup.otpauth_url} />
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Can&apos;t scan? Enter this secret:</p>
              <CopyField value={setup.secret} />
            </div>
            <Form {...form}>
              <form onSubmit={form.handleSubmit((v) => enable.mutate(v))} className="space-y-4" noValidate>
                <TextField
                  control={form.control}
                  name="code"
                  label="6-digit code from the app"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  mono
                />
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={close}>
                    Cancel
                  </Button>
                  <SubmitButton pending={enable.isPending}>Verify &amp; enable</SubmitButton>
                </DialogFooter>
              </form>
            </Form>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DisableDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const form = useForm<z.infer<typeof disableSchema>>({ resolver: zodResolver(disableSchema), defaultValues: { code: "" } });
  const disable = useApiMutation({
    mutationFn: (v: z.infer<typeof disableSchema>) => api.auth.totpDisable({ code: v.code }),
    success: "Two-factor authentication disabled",
    invalidate: [qk.me],
    onSuccess: () => {
      form.reset();
      onOpenChange(false);
    },
    errorTitle: "Couldn't disable 2FA",
  });
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) form.reset(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disable two-factor authentication?</DialogTitle>
          <DialogDescription>Your account will be protected by your password only.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => disable.mutate(v))} className="space-y-4" noValidate>
            <TextField control={form.control} name="code" label="Authentication or recovery code" autoComplete="one-time-code" mono />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <SubmitButton pending={disable.isPending} variant="destructive">
                Disable 2FA
              </SubmitButton>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function TotpCard() {
  const { user, impersonating } = useSession();
  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Two-factor authentication
          {user.totp_enabled ? <Badge variant="success">On</Badge> : <Badge variant="muted">Off</Badge>}
        </CardTitle>
        <CardDescription>Require a code from your authenticator app at sign-in.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {impersonating ? (
          <p className="text-sm text-muted-foreground">2FA settings can&apos;t be changed while impersonating.</p>
        ) : user.totp_enabled ? (
          <Button variant="outline" onClick={() => setDisableOpen(true)}>
            <ShieldOff /> Disable 2FA
          </Button>
        ) : (
          <Button onClick={() => setSetupOpen(true)}>
            <ShieldCheck /> Set up 2FA
          </Button>
        )}
      </CardContent>
      <SetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
      <DisableDialog open={disableOpen} onOpenChange={setDisableOpen} />
    </Card>
  );
}
