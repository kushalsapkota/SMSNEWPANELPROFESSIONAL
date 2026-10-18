"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form } from "@/components/ui/form";
import { SubmitButton, TextField } from "@/components/shared/form-fields";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import { useSession } from "@/lib/auth/session";

const schema = z.object({
  brand_name: z.string().trim().max(100),
  whitelabel_domain: z
    .string()
    .trim()
    .toLowerCase()
    .refine(
      (v) => v === "" || /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(v),
      "Enter a domain like panel.example.com",
    ),
});
type Values = z.infer<typeof schema>;

/** Reseller whitelabel: brand shown in the panel header for its clients and in {brand}. */
export function BrandingCard() {
  const { org } = useSession();
  const values = (): Values => ({ brand_name: org.brand_name ?? "", whitelabel_domain: org.whitelabel_domain ?? "" });
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: values() });
  useEffect(() => {
    form.reset({ brand_name: org.brand_name ?? "", whitelabel_domain: org.whitelabel_domain ?? "" });
  }, [org.brand_name, org.whitelabel_domain, form]);
  const save = useApiMutation({
    mutationFn: (v: Values) =>
      api.orgs.update(org.id, {
        brand_name: v.brand_name || null,
        whitelabel_domain: v.whitelabel_domain || null,
      }),
    success: "Branding saved",
    invalidate: [qk.me, qk.orgs.all],
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Branding</CardTitle>
        <CardDescription>
          Your clients see this brand name in the panel header, and it fills <code>{"{brand}"}</code> in OTP
          templates unless a client sets its own.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
            <TextField control={form.control} name="brand_name" label="Brand name" placeholder="Acme SMS" />
            <TextField
              control={form.control}
              name="whitelabel_domain"
              label="Whitelabel domain"
              placeholder="sms.acme.com"
              description="Point a CNAME for this domain at the panel; clients can then sign in on your domain."
            />
            <div className="flex justify-end">
              <SubmitButton pending={save.isPending} disabled={!form.formState.isDirty}>
                Save branding
              </SubmitButton>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
