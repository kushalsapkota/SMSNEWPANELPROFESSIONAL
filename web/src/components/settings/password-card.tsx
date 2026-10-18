"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form } from "@/components/ui/form";
import { SubmitButton, TextField } from "@/components/shared/form-fields";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import { tokenStore } from "@/lib/auth/token-store";
import { passwordSchema } from "@/lib/validation";

const schema = z
  .object({
    current_password: z.string().min(1, "Required"),
    new_password: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.new_password === v.confirm, { path: ["confirm"], message: "Passwords don't match" })
  .refine((v) => v.new_password !== v.current_password, {
    path: ["new_password"],
    message: "Choose a different password",
  });
type Values = z.infer<typeof schema>;

export function PasswordCard() {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { current_password: "", new_password: "", confirm: "" },
  });
  const change = useApiMutation({
    // The api revokes every session (including this tab's tokens) and returns fresh ones;
    // store them before anything refetches.
    mutationFn: async (v: Values) => {
      const pair = await api.auth.changePassword({ current_password: v.current_password, new_password: v.new_password });
      tokenStore.set({ access_token: pair.access_token, refresh_token: pair.refresh_token });
      return pair;
    },
    success: "Password changed. Other sessions were signed out.",
    invalidate: [qk.me],
    onSuccess: () => form.reset(),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Change password</CardTitle>
        <CardDescription>At least 8 characters.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => change.mutate(v))} className="space-y-4" noValidate>
            <TextField control={form.control} name="current_password" label="Current password" type="password" autoComplete="current-password" />
            <TextField control={form.control} name="new_password" label="New password" type="password" autoComplete="new-password" />
            <TextField control={form.control} name="confirm" label="Confirm new password" type="password" autoComplete="new-password" />
            <div className="flex justify-end">
              <SubmitButton pending={change.isPending}>Change password</SubmitButton>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
