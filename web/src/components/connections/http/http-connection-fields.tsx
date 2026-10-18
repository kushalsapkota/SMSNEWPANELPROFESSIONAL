"use client";

import { ExternalLink, AlertTriangle, Undo2, X } from "lucide-react";
import { useFormContext, useWatch, type Control, type FieldPath, type FieldValues } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SelectField, SwitchField, TextareaField, TextField } from "@/components/shared/form-fields";
import type { Adapter, AdapterSettingField } from "@/lib/api/types";
import {
  GENERIC_HTTP_EXAMPLE,
  GENERIC_HTTP_ID,
  TEMPLATE_PLACEHOLDERS,
  countryLabel,
  dlrModeText,
  groupAdaptersByCountry,
  initialHttpValues,
  isLikely,
  selectOptions,
  settingInput,
  settingPlaceholder,
} from "@/lib/http-adapters";

/** Grouped (by country) provider dropdown; LIKELY adapters carry a "Best effort" badge. */
export function AdapterSelect<T extends FieldValues>({
  control,
  name,
  adapters,
  onPicked,
  disabled,
}: {
  control: Control<T>;
  name: FieldPath<T>;
  adapters: Adapter[];
  onPicked?: (id: string) => void;
  disabled?: boolean;
}) {
  const groups = groupAdaptersByCountry(adapters);
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>Provider</FormLabel>
          <Select
            value={(field.value as string) || ""}
            onValueChange={(v) => {
              field.onChange(v);
              onPicked?.(v);
            }}
            disabled={disabled}
          >
            <FormControl>
              <SelectTrigger aria-label="Provider" onBlur={field.onBlur} ref={field.ref}>
                <SelectValue placeholder={adapters.length ? "Pick a provider" : "Loading providers…"} />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {groups.map((g) => (
                <SelectGroup key={g.label}>
                  <SelectLabel>{g.label}</SelectLabel>
                  {g.adapters.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="flex items-center gap-2">
                        {a.name}
                        {isLikely(a) ? (
                          <Badge variant="warning" className="px-1.5 py-0 text-[10px]">
                            Best effort
                          </Badge>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** Notes, docs link, confidence warning and DLR behaviour of the picked adapter. */
export function AdapterInfo({ adapter }: { adapter: Adapter }) {
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm" data-testid="adapter-info">
      {isLikely(adapter) ? (
        <p className="flex items-start gap-2 text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Best effort: this provider&apos;s API is only partly documented. Send a test SMS before you route real traffic.
        </p>
      ) : null}
      {adapter.notes ? <p className="text-muted-foreground">{adapter.notes}</p> : null}
      <p className="text-muted-foreground">{dlrModeText(adapter.dlr_mode)}</p>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>Destinations: {adapter.destination_countries?.length ? adapter.destination_countries.map(countryLabel).join(", ") : "any country"}</span>
        {adapter.docs_url ? (
          <a href={adapter.docs_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-foreground hover:underline">
            Provider API docs <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        ) : null}
      </p>
    </div>
  );
}

function SettingField<T extends FieldValues>({ control, name, field }: { control: Control<T>; name: FieldPath<T>; field: AdapterSettingField }) {
  const label = `${field.label}${field.required && field.default == null ? "" : " (optional)"}`;
  const help = field.help ?? undefined;
  switch (settingInput(field)) {
    case "switch":
      return <SwitchField control={control} name={name} label={field.label} description={help} />;
    case "select":
      return <SelectField control={control} name={name} label={label} description={help} options={selectOptions(field)} />;
    case "textarea":
      return <TextareaField control={control} name={name} label={label} description={help} rows={5} mono placeholder={settingPlaceholder(field)} />;
    default:
      return <TextField control={control} name={name} label={label} description={help} mono={field.type === "url"} placeholder={settingPlaceholder(field)} />;
  }
}

function GenericHttpHelp({ prefix }: { prefix: string }) {
  const { setValue } = useFormContext();
  const useExample = () => {
    for (const [k, v] of Object.entries(GENERIC_HTTP_EXAMPLE)) {
      if (k !== "success") setValue(`${prefix}.settings.${k}`, v, { shouldDirty: true, shouldValidate: true });
    }
  };
  return (
    <div className="space-y-2 rounded-md border border-dashed p-3 text-sm" data-testid="generic-http-help">
      <p className="font-medium">Request template</p>
      <p className="text-muted-foreground">
        Placeholders: {TEMPLATE_PLACEHOLDERS.map((p) => <code key={p} className="mr-1 rounded bg-muted px-1">{p}</code>)} and any credential, e.g.{" "}
        <code className="rounded bg-muted px-1">{"{token}"}</code>.
      </p>
      <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">
        {`${GENERIC_HTTP_EXAMPLE.method} ${GENERIC_HTTP_EXAMPLE.url}  (${GENERIC_HTTP_EXAMPLE.body_type})\n${GENERIC_HTTP_EXAMPLE.params_template}\nSuccess: ${GENERIC_HTTP_EXAMPLE.success}`}
      </pre>
      <Button type="button" variant="outline" size="sm" onClick={useExample}>
        Use this example
      </Button>
    </div>
  );
}

/**
 * The adapter-driven part of an HTTP connection form, at `prefix` (`http` or
 * `connections.2.http`): provider dropdown, info, credentials (secret ones as password inputs,
 * write-only on edit) and settings. Must be rendered inside <Form {...form}>.
 */
export function HttpConnectionFields<T extends FieldValues>({
  control,
  prefix,
  adapters,
  credentialsSet,
  cleared = [],
  onToggleClear,
  lockAdapter,
}: {
  control: Control<T>;
  prefix: string;
  adapters: Adapter[];
  /** Edit: stored credential names (values are never shown). */
  credentialsSet?: string[];
  cleared?: string[];
  onToggleClear?: (key: string) => void;
  lockAdapter?: boolean;
}) {
  const { setValue } = useFormContext();
  const adapterId = useWatch({ control, name: `${prefix}.adapter` as FieldPath<T> }) as string;
  const adapter = adapters.find((a) => a.id === adapterId);
  const editing = credentialsSet !== undefined;
  const n = (s: string) => `${prefix}.${s}` as FieldPath<T>;

  const onPicked = (id: string) => {
    const init = initialHttpValues(adapters.find((a) => a.id === id), id);
    setValue(`${prefix}.credentials`, init.credentials, { shouldDirty: true });
    setValue(`${prefix}.settings`, init.settings, { shouldDirty: true });
  };

  return (
    <div className="space-y-4">
      <AdapterSelect control={control} name={n("adapter")} adapters={adapters} onPicked={onPicked} disabled={lockAdapter} />
      {adapter ? (
        <>
          <AdapterInfo adapter={adapter} />
          {adapter.credentials.length ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {adapter.credentials.map((c) => {
                const isSet = editing && credentialsSet.includes(c.key);
                const isCleared = cleared.includes(c.key);
                const description = editing
                  ? isCleared
                    ? "Will be removed when you save."
                    : isSet
                      ? "Saved. Leave blank to keep it."
                      : "Not set."
                  : (c.help ?? undefined);
                return (
                  <div key={c.key} className="space-y-1">
                    <TextField
                      control={control}
                      name={n(`credentials.${c.key}`)}
                      label={
                        <span className="inline-flex items-center gap-2">
                          {c.label}
                          {!c.required ? <span className="font-normal text-muted-foreground">(optional)</span> : null}
                          {isSet && !isCleared ? <Badge variant="success">Set</Badge> : null}
                        </span>
                      }
                      type={c.secret ? "password" : "text"}
                      autoComplete={c.secret ? "new-password" : "off"}
                      placeholder={isSet && !isCleared ? "••••••••" : (c.placeholder ?? undefined)}
                      description={description}
                      mono
                    />
                    {isSet && !c.required && onToggleClear ? (
                      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onToggleClear(c.key)}>
                        {isCleared ? <Undo2 /> : <X />} {isCleared ? "Keep it" : `Remove saved ${c.label.toLowerCase()}`}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          {adapter.id === GENERIC_HTTP_ID ? <GenericHttpHelp prefix={prefix} /> : null}
          {adapter.settings.length ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {adapter.settings.map((s) => (
                <div key={s.key} className={settingInput(s) === "textarea" ? "sm:col-span-2" : undefined}>
                  <SettingField control={control} name={n(`settings.${s.key}`)} field={s} />
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Small "HTTP API · Provider" label used in lists and the status card. */
export function AdapterLabel({ adapters, id }: { adapters: Adapter[] | undefined; id: string | null | undefined }) {
  const a = adapters?.find((x) => x.id === id);
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
        HTTP API
      </Badge>
      <span>{a?.name ?? id}</span>
      {a && isLikely(a) ? (
        <Badge variant="warning" className="px-1.5 py-0 text-[10px]">
          Best effort
        </Badge>
      ) : null}
    </span>
  );
}

