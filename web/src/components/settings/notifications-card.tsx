"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form } from "@/components/ui/form";
import { SubmitButton, SwitchField, TextField } from "@/components/shared/form-fields";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import type { NotificationSettings } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";

const schema = z
  .object({
    email_enabled: z.boolean(),
    email_to: z.string().superRefine((v, ctx) => {
      const bad = v
        .split(/[,\s]+/)
        .filter(Boolean)
        .filter((e) => !z.string().email().safeParse(e).success);
      if (bad.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid email: ${bad.join(", ")}` });
      else if (v.split(/[,\s]+/).filter(Boolean).length > 10) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "At most 10 recipients" });
    }),
    telegram_enabled: z.boolean(),
    telegram_chat_id: z
      .string()
      .trim()
      .refine((v) => v === "" || /^-?[0-9]{1,20}$|^@[A-Za-z0-9_]{5,32}$/.test(v), "Numeric chat id or @channel"),
    low_balance: z.boolean(),
    route_down: z.boolean(),
  })
  .refine((v) => !v.telegram_enabled || v.telegram_chat_id !== "", {
    path: ["telegram_chat_id"],
    message: "Required when Telegram is enabled",
  });
type Values = z.infer<typeof schema>;

const toValues = (s: NotificationSettings): Values => ({
  email_enabled: s.email_enabled,
  email_to: s.email_to.join(", "),
  telegram_enabled: s.telegram_enabled,
  telegram_chat_id: s.telegram_chat_id ?? "",
  low_balance: s.low_balance,
  route_down: s.route_down,
});

export function NotificationsCard() {
  const { role } = useSession();
  const q = useQuery({ queryKey: qk.notifications.settings(), queryFn: () => api.notifications.get() });
  const form = useForm<Values>({ resolver: zodResolver(schema) });
  useEffect(() => {
    if (q.data) form.reset(toValues(q.data));
  }, [q.data, form]);
  const save = useApiMutation({
    mutationFn: (v: Values) =>
      api.notifications.update({
        email_enabled: v.email_enabled,
        email_to: v.email_to.split(/[,\s]+/).filter(Boolean),
        telegram_enabled: v.telegram_enabled,
        telegram_chat_id: v.telegram_chat_id || null,
        low_balance: v.low_balance,
        route_down: v.route_down,
      }),
    success: "Notification settings saved",
    invalidate: [qk.notifications.all],
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Notifications</CardTitle>
        <CardDescription>Where to send alerts.</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <LoadingState rows={3} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
              <SwitchField control={form.control} name="email_enabled" label="Email alerts" />
              <TextField
                control={form.control}
                name="email_to"
                label="Email recipients"
                placeholder="ops@example.com, billing@example.com"
                description="Comma separated. Empty = account owner."
              />
              <SwitchField control={form.control} name="telegram_enabled" label="Telegram alerts" />
              <TextField control={form.control} name="telegram_chat_id" label="Telegram chat ID" mono />
              <SwitchField control={form.control} name="low_balance" label="Low balance" description="Alert when balance drops below the configured threshold." />
              {role === "SUPER_ADMIN" ? (
                <SwitchField control={form.control} name="route_down" label="Connection down" description="Alert when an upstream connection loses all sessions." />
              ) : null}
              <div className="flex justify-end">
                <SubmitButton pending={save.isPending} disabled={!form.formState.isDirty}>
                  Save
                </SubmitButton>
              </div>
            </form>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}
