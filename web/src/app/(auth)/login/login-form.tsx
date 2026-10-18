"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { MessageSquareText, ShieldCheck } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form } from "@/components/ui/form";
import { SubmitButton, TextField } from "@/components/shared/form-fields";
import { errorMessage, isApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { emailSchema, totpCodeSchema } from "@/lib/validation";

const credentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Required"),
});
const totpSchema = z.object({ totp_code: totpCodeSchema });

type Credentials = z.infer<typeof credentialsSchema>;

/** Only allow same-site relative redirects. */
function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/login")) {
    return "/dashboard";
  }
  return next;
}

export function LoginForm() {
  const { login, status } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const next = safeNext(search.get("next"));
  const [step, setStep] = useState<"credentials" | "totp">("credentials");
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (status === "authenticated") router.replace(next);
  }, [status, router, next]);

  const credForm = useForm<Credentials>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { email: "", password: "" },
  });
  const totpForm = useForm<z.infer<typeof totpSchema>>({
    resolver: zodResolver(totpSchema),
    defaultValues: { totp_code: "" },
  });

  const submit = async (values: Credentials, totp_code?: string) => {
    setPending(true);
    setError(null);
    try {
      const res = await login({ ...values, ...(totp_code ? { totp_code } : {}) });
      if ("requires_totp" in res && res.requires_totp) {
        if (totp_code) {
          setError("Invalid authentication code");
        } else {
          setCreds(values);
          setStep("totp");
        }
        return;
      }
      router.replace(next);
    } catch (e) {
      const lockedUntil = isApiError(e) ? e.details?.locked_until : undefined;
      if (typeof lockedUntil === "string") {
        setError(`Too many failed attempts. Try again after ${formatDateTime(lockedUntil)}.`);
      } else if (isApiError(e) && e.code === "IP_NOT_ALLOWED") {
        setError("Sign-in is not allowed from your IP address.");
      } else if (isApiError(e) && e.status === 401) {
        setError(totp_code ? "Invalid authentication code" : "Invalid email or password");
      } else if (isApiError(e) && e.code === "ACCOUNT_SUSPENDED") {
        setError("This account is suspended. Contact your provider.");
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="space-y-3 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          {step === "totp" ? <ShieldCheck aria-hidden /> : <MessageSquareText aria-hidden />}
        </div>
        <CardTitle className="text-xl">
          {step === "totp" ? "Two-factor authentication" : "Sign in"}
        </CardTitle>
        <CardDescription>
          {step === "totp"
            ? "Enter the 6-digit code from your authenticator app, or a recovery code."
            : "Sign in to your SMS gateway account"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {step === "credentials" ? (
          <Form {...credForm}>
            <form
              className="space-y-4"
              onSubmit={credForm.handleSubmit((v) => submit(v))}
              noValidate
            >
              <TextField
                control={credForm.control}
                name="email"
                label="Email"
                type="email"
                autoComplete="username"
              />
              <TextField
                control={credForm.control}
                name="password"
                label="Password"
                type="password"
                autoComplete="current-password"
              />
              <SubmitButton pending={pending} className="w-full">
                Sign in
              </SubmitButton>
            </form>
          </Form>
        ) : (
          <Form {...totpForm}>
            <form
              className="space-y-4"
              onSubmit={totpForm.handleSubmit((v) => creds && submit(creds, v.totp_code))}
              noValidate
            >
              <TextField
                control={totpForm.control}
                name="totp_code"
                label="Authentication code"
                autoComplete="one-time-code"
                placeholder="123456"
                mono
              />
              <SubmitButton pending={pending} className="w-full">
                Verify
              </SubmitButton>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setStep("credentials");
                  setError(null);
                  totpForm.reset();
                }}
              >
                Back
              </Button>
            </form>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}
