"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  NumberField,
  SelectField,
  SubmitButton,
  SwitchField,
  TextareaField,
  TextField,
  type Option,
} from "@/components/shared/form-fields";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import type { InlineTemplate, RouteTemplate, TemplateFallback } from "@/lib/api/types";
import { re2Schema } from "@/lib/validation";
import { TemplatePreview } from "./template-preview";

/** Defaults mirror route_templates column defaults in 001_init.sql. */
export const DEFAULT_PATTERNS = [
  "\\b[0-9]{4,8}\\b",
  "\\b[A-Za-z0-9]*(?:[A-Za-z][0-9]|[0-9][A-Za-z])[A-Za-z0-9]*\\b",
];

export const FALLBACK_OPTIONS: Array<{ value: TemplateFallback; label: string }> = [
  { value: "SEND_RAW", label: "Send original text" },
  { value: "REJECT", label: "Reject (OTP_NOT_FOUND)" },
  { value: "SEND_DEFAULT_TEMPLATE", label: "Send default template" },
];

const schema = z
  .object({
    route_id: z.string().min(1, "Pick a route"),
    org_id: z.string().nullable(),
    name: z.string().trim().min(1, "Required").max(100),
    extract_patterns: z
      .array(z.object({ value: re2Schema }))
      .min(1, "At least one pattern")
      .max(10, "At most 10 patterns"),
    otp_min_len: z.number({ invalid_type_error: "Required" }).int().min(1).max(32),
    otp_max_len: z.number({ invalid_type_error: "Required" }).int().min(1).max(32),
    template_body: z
      .string()
      .min(1, "Required")
      .refine((v) => v.includes("{otp}"), "Must contain {otp}"),
    default_body: z.string(),
    fallback_action: z.enum(["REJECT", "SEND_RAW", "SEND_DEFAULT_TEMPLATE"]).nullable(),
    brand: z.string().trim().max(100),
    is_active: z.boolean(),
  })
  .refine((v) => v.otp_max_len >= v.otp_min_len, { path: ["otp_max_len"], message: "Must be ≥ min length" })
  .refine((v) => v.fallback_action !== "SEND_DEFAULT_TEMPLATE" || v.default_body.trim() !== "", {
    path: ["default_body"],
    message: "Required when fallback is “Send default template”",
  });

type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;

function toValues(t: RouteTemplate | null, routeId: string, orgId: string | null): Values {
  return {
    route_id: t?.route_id ?? routeId,
    org_id: t ? t.org_id : orgId,
    name: t?.name ?? "",
    extract_patterns: (t?.extract_patterns ?? DEFAULT_PATTERNS).map((value) => ({ value })),
    otp_min_len: t?.otp_min_len ?? 4,
    otp_max_len: t?.otp_max_len ?? 8,
    template_body: t?.template_body ?? "Your {brand} verification code is {otp}. Do not share it.",
    default_body: t?.default_body ?? "",
    fallback_action: t ? t.fallback_action : null,
    brand: t?.brand ?? "",
    is_active: t?.is_active ?? true,
  };
}

function toInline(v: Values): InlineTemplate {
  return {
    extract_patterns: v.extract_patterns.map((p) => p.value),
    otp_min_len: v.otp_min_len,
    otp_max_len: v.otp_max_len,
    template_body: v.template_body,
    default_body: v.default_body.trim() ? v.default_body : null,
    fallback_action: v.fallback_action,
    brand: v.brand.trim() ? v.brand.trim() : null,
  };
}

export interface TemplateEditorProps {
  open: boolean;
  onClose: () => void;
  /** null = create */
  template: RouteTemplate | null;
  routeOptions: Option[];
  /** For per-client overrides: the client org (fixed) or a picker. */
  orgId?: string | null;
  orgOptions?: Option[];
  defaultRouteId?: string;
}

/**
 * Create / edit a route template (admin: route-wide, reseller: client
 * override) with the live engine preview side by side.
 */
export function TemplateEditorDialog({
  open,
  onClose,
  template,
  routeOptions,
  orgId = null,
  orgOptions,
  defaultRouteId,
}: TemplateEditorProps) {
  const form = useForm<Values, unknown, Output>({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: toValues(template, defaultRouteId ?? "", orgId),
  });
  const patterns = useFieldArray({ control: form.control, name: "extract_patterns" });

  useEffect(() => {
    if (open) form.reset(toValues(template, defaultRouteId ?? routeOptions[0]?.value ?? "", orgId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template]);

  const watched = useWatch({ control: form.control }) as Values;
  const inline = useMemo(() => toInline({ ...toValues(null, "", null), ...watched } as Values), [watched]);
  const previewValid = schema.safeParse(watched).success;
  const isOverride = !!(template ? template.org_id : orgId) || !!orgOptions;

  const save = useApiMutation({
    mutationFn: (v: Output) => {
      const common = {
        name: v.name,
        extract_patterns: v.extract_patterns.map((p) => p.value),
        otp_min_len: v.otp_min_len,
        otp_max_len: v.otp_max_len,
        template_body: v.template_body,
        default_body: v.default_body.trim() ? v.default_body : null,
        fallback_action: v.fallback_action,
        brand: v.brand || null,
        is_active: v.is_active,
      };
      return template
        ? api.templates.update(template.id, common)
        : api.templates.create({ ...common, route_id: v.route_id, org_id: v.org_id });
    },
    success: template ? "Template saved" : "Template created",
    invalidate: [qk.templates.all],
    onSuccess: onClose,
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {template ? "Edit template" : isOverride ? "New client template override" : "New route template"}
          </DialogTitle>
          <DialogDescription>
            OTP is extracted with the first matching pattern whose length is within the bounds, then
            rendered into the body. Variables: <code>{"{otp}"}</code> <code>{"{brand}"}</code>{" "}
            <code>{"{sender}"}</code>.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((v) => {
              if (orgOptions && !template && !v.org_id) {
                form.setError("org_id", { message: "Pick a client" });
                return;
              }
              save.mutate(v);
            })}
            noValidate
          >
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField
                    control={form.control}
                    name="route_id"
                    label="Route"
                    options={routeOptions}
                    disabled={!!template}
                  />
                  {orgOptions && !template ? (
                    <SelectField control={form.control} name="org_id" label="Client" options={orgOptions} />
                  ) : (
                    <TextField control={form.control} name="name" label="Name" />
                  )}
                </div>
                {orgOptions && !template ? <TextField control={form.control} name="name" label="Name" /> : null}

                <div className="space-y-2">
                  <FormLabel>Extract patterns (RE2, tried in order)</FormLabel>
                  {patterns.fields.map((f, i) => (
                    <FormField
                      key={f.id}
                      control={form.control}
                      name={`extract_patterns.${i}.value`}
                      render={({ field }) => (
                        <FormItem>
                          <div className="flex gap-2">
                            <FormControl>
                              <Input {...field} className="font-mono text-sm" spellCheck={false} aria-label={`Pattern ${i + 1}`} />
                            </FormControl>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              disabled={patterns.fields.length <= 1}
                              onClick={() => patterns.remove(i)}
                              aria-label={`Remove pattern ${i + 1}`}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={patterns.fields.length >= 10}
                    onClick={() => patterns.append({ value: "" })}
                  >
                    <Plus /> Add pattern
                  </Button>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <NumberField control={form.control} name="otp_min_len" label="OTP min length" min={1} />
                  <NumberField control={form.control} name="otp_max_len" label="OTP max length" min={1} />
                </div>
                <TextareaField control={form.control} name="template_body" label="Template body" rows={3} mono />
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField
                    control={form.control}
                    name="fallback_action"
                    label="When no OTP is found"
                    options={FALLBACK_OPTIONS}
                    nullable
                    noneLabel="Inherit from route"
                  />
                  <TextField control={form.control} name="brand" label="Brand override" description="Empty = account brand name." />
                </div>
                <TextareaField
                  control={form.control}
                  name="default_body"
                  label="Default body"
                  description="Sent by “Send default template” fallback; same variables."
                  rows={2}
                  mono
                />
                <SwitchField
                  control={form.control}
                  name="is_active"
                  label="Active"
                  description="Only one active template per route and client."
                />
              </div>
              <div className="lg:border-l lg:pl-6">
                <h3 className="mb-3 text-sm font-semibold">Live preview</h3>
                <TemplatePreview
                  template={inline}
                  routeId={watched.route_id}
                  orgId={watched.org_id ?? undefined}
                  valid={previewValid}
                />
              </div>
            </div>
            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <SubmitButton pending={save.isPending}>{template ? "Save template" : "Create template"}</SubmitButton>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
