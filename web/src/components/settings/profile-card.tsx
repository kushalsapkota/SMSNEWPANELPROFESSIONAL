"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form } from "@/components/ui/form";
import { SubmitButton, TextField } from "@/components/shared/form-fields";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import { useSession } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/nav";

const schema = z.object({
  timezone: z
    .string()
    .trim()
    .min(1, "Required")
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Unknown IANA timezone (e.g. Asia/Kolkata)"),
});

export function ProfileCard() {
  const { user, org, role } = useSession();
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { timezone: org.timezone } });
  useEffect(() => form.reset({ timezone: org.timezone }), [org.timezone, form]);
  const save = useApiMutation({
    mutationFn: (v: z.infer<typeof schema>) => api.orgs.update(org.id, { timezone: v.timezone }),
    success: "Timezone saved",
    invalidate: [qk.me, qk.orgs.all],
  });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your account</CardTitle>
          <CardDescription>Contact your administrator to change your name or email.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto,1fr] gap-x-6 gap-y-3 text-sm">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{user.full_name || "—"}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd className="break-all">{user.email}</dd>
            <dt className="text-muted-foreground">Two-factor</dt>
            <dd>{user.totp_enabled ? <Badge variant="success">Enabled</Badge> : <Badge variant="muted">Off</Badge>}</dd>
            <dt className="text-muted-foreground">Last login</dt>
            <dd>{formatDateTime(user.last_login_at)}</dd>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Organization</CardTitle>
          <CardDescription>
            {org.name} · {ROLE_LABEL[role]}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
              <TextField
                control={form.control}
                name="timezone"
                label="Timezone"
                description="Used for daily limits and reports."
                placeholder="UTC"
              />
              <div className="flex justify-end">
                <SubmitButton pending={save.isPending} disabled={!form.formState.isDirty}>
                  Save
                </SubmitButton>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
