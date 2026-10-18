"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Form } from "@/components/ui/form";
import {
  SelectField,
  SubmitButton,
  SwitchField,
  TextareaField,
  TextField,
} from "@/components/shared/form-fields";
import { FALLBACK_OPTIONS } from "@/components/templates/template-editor";
import type { CreateRouteRequest, Route } from "@/lib/api/types";
import { isValidSender } from "@/lib/phone";

const schema = z.object({
  name: z.string().trim().min(1, "Required").max(100),
  description: z.string().trim().max(1000),
  enabled: z.boolean(),
  template_mode: z.boolean(),
  template_fallback: z.enum(["REJECT", "SEND_RAW", "SEND_DEFAULT_TEMPLATE"]),
  force_sender_id: z
    .string()
    .trim()
    .max(16)
    .refine((v) => v === "" || isValidSender(v), "Alphanumeric ≤ 11 chars or numeric ≤ 15 digits"),
});
type Values = z.infer<typeof schema>;

const DEFAULTS: Values = {
  name: "",
  description: "",
  enabled: true,
  template_mode: false,
  template_fallback: "SEND_RAW",
  force_sender_id: "",
};

const toValues = (r: Route): Values => ({
  name: r.name,
  description: r.description ?? "",
  enabled: r.enabled,
  template_mode: r.template_mode,
  template_fallback: r.template_fallback,
  force_sender_id: r.force_sender_id ?? "",
});

export function RouteForm({
  route,
  pending,
  onSubmit,
  submitLabel,
}: {
  route?: Route;
  pending: boolean;
  onSubmit: (body: CreateRouteRequest) => void;
  submitLabel: string;
}) {
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: route ? toValues(route) : DEFAULTS });
  useEffect(() => {
    if (route) form.reset(toValues(route));
  }, [route, form]);
  const templateMode = form.watch("template_mode");
  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((v) =>
          onSubmit({
            ...v,
            description: v.description || null,
            force_sender_id: v.force_sender_id || null,
          }),
        )}
        className="space-y-4"
        noValidate
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField control={form.control} name="name" label="Name" placeholder="IN-OTP-Premium" />
          <TextField
            control={form.control}
            name="force_sender_id"
            label="Force sender ID"
            placeholder="(client's sender)"
            description="Overrides every client's sender on this route."
          />
        </div>
        <TextareaField control={form.control} name="description" label="Description" rows={2} />
        <div className="grid gap-4 sm:grid-cols-2">
          <SwitchField control={form.control} name="enabled" label="Enabled" />
          <SwitchField
            control={form.control}
            name="template_mode"
            label="Template mode"
            description="Extract OTPs and rewrite messages with the route template."
          />
        </div>
        <SelectField
          control={form.control}
          name="template_fallback"
          label="Fallback when no OTP is found"
          options={FALLBACK_OPTIONS}
          disabled={!templateMode}
          description="Templates can override this per template."
        />
        <div className="flex justify-end">
          <SubmitButton pending={pending} disabled={!!route && !form.formState.isDirty}>
            {submitLabel}
          </SubmitButton>
        </div>
      </form>
    </Form>
  );
}
