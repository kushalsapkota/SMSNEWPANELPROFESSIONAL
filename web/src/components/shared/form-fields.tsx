"use client";

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/shared/money";
import { checkCidr } from "@/lib/cidr";
import { stripPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

/**
 * react-hook-form field wrappers around the shadcn <Form*> primitives.
 * Each renders label, control, description and the zod error message with
 * the correct aria wiring. Usage:
 *
 *   <Form {...form}><form onSubmit={form.handleSubmit(onSubmit)}>
 *     <TextField control={form.control} name="email" label="Email" type="email" />
 *   </form></Form>
 */

interface BaseProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: ReactNode;
  description?: ReactNode;
  className?: string;
  disabled?: boolean;
}

export function TextField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  disabled,
  type = "text",
  placeholder,
  autoComplete,
  inputClassName,
  mono,
}: BaseProps<T> & {
  type?: "text" | "email" | "password" | "url" | "tel" | "search" | "datetime-local" | "date";
  placeholder?: string;
  autoComplete?: string;
  inputClassName?: string;
  mono?: boolean;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              {...field}
              value={field.value ?? ""}
              type={type}
              placeholder={placeholder}
              autoComplete={autoComplete}
              disabled={disabled}
              className={cn(mono && "font-mono", inputClassName)}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** Integer/decimal input whose form value is `number | null` (empty → null). */
export function NumberField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  disabled,
  placeholder,
  min,
  max,
  step,
}: BaseProps<T> & { placeholder?: string; min?: number; max?: number; step?: number }) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              ref={field.ref}
              name={field.name}
              onBlur={field.onBlur}
              type="number"
              inputMode="numeric"
              min={min}
              max={max}
              step={step ?? 1}
              placeholder={placeholder}
              disabled={disabled}
              value={field.value === null || field.value === undefined ? "" : String(field.value)}
              onChange={(e) => {
                const v = e.target.value;
                field.onChange(v === "" ? null : Number(v));
              }}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function TextareaField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  disabled,
  placeholder,
  rows = 3,
  mono,
}: BaseProps<T> & { placeholder?: string; rows?: number; mono?: boolean }) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Textarea
              {...field}
              value={field.value ?? ""}
              rows={rows}
              placeholder={placeholder}
              disabled={disabled}
              className={cn(mono && "font-mono text-sm")}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function SwitchField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  disabled,
}: BaseProps<T>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem
          className={cn(
            "flex flex-row items-center justify-between gap-4 rounded-lg border p-3",
            className,
          )}
        >
          <div className="space-y-0.5">
            <FormLabel>{label}</FormLabel>
            {description ? <FormDescription>{description}</FormDescription> : null}
          </div>
          <FormControl>
            <Switch
              checked={!!field.value}
              onCheckedChange={field.onChange}
              disabled={disabled}
              onBlur={field.onBlur}
              ref={field.ref}
            />
          </FormControl>
        </FormItem>
      )}
    />
  );
}

export interface Option {
  value: string;
  label: string;
}

const NONE = "__none__";

/** Select; with `nullable` an extra "None" option maps to null. */
export function SelectField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  disabled,
  options,
  placeholder = "Select…",
  nullable,
  noneLabel = "None",
}: BaseProps<T> & {
  options: Option[];
  placeholder?: string;
  nullable?: boolean;
  noneLabel?: string;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <Select
            value={field.value === null || field.value === undefined ? (nullable ? NONE : "") : String(field.value)}
            onValueChange={(v) => field.onChange(v === NONE ? null : v)}
            disabled={disabled}
          >
            <FormControl>
              <SelectTrigger onBlur={field.onBlur} ref={field.ref}>
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {nullable ? <SelectItem value={NONE}>{noneLabel}</SelectItem> : null}
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** Multi-checkbox for string-array values (bind types, webhook events, scopes). */
export function CheckboxGroupField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  disabled,
  options,
}: BaseProps<T> & { options: Option[] }) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        const values: string[] = Array.isArray(field.value) ? field.value : [];
        return (
          <FormItem className={className}>
            <FormLabel>{label}</FormLabel>
            <div className="flex flex-wrap gap-4" role="group">
              {options.map((o) => {
                const id = `${field.name}-${o.value}`;
                return (
                  <div key={o.value} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      disabled={disabled}
                      checked={values.includes(o.value)}
                      onCheckedChange={(checked) =>
                        field.onChange(
                          checked ? [...values, o.value] : values.filter((v) => v !== o.value),
                        )
                      }
                    />
                    <label htmlFor={id} className="text-sm">
                      {o.label}
                    </label>
                  </div>
                );
              })}
            </div>
            {description ? <FormDescription>{description}</FormDescription> : null}
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

/** Currency input; form value is integer micros (`number | null`). */
export function MoneyField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  disabled,
  currency,
  allowNegative,
  placeholder,
}: BaseProps<T> & { currency?: string; allowNegative?: boolean; placeholder?: string }) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <MoneyInput
              ref={field.ref}
              name={field.name}
              onBlur={field.onBlur}
              value={field.value}
              onChange={field.onChange}
              currency={currency}
              allowNegative={allowNegative}
              placeholder={placeholder ?? "0.00"}
              disabled={disabled}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/**
 * MSISDN input: strips "+", spaces and dashes on blur so the stored value is
 * digits only (validate with `msisdnSchema` from lib/validation).
 */
export function PhoneField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  disabled,
  placeholder = "+91 98765 43210",
}: BaseProps<T> & { placeholder?: string }) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              {...field}
              value={field.value ?? ""}
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder={placeholder}
              disabled={disabled}
              className="font-mono"
              onBlur={() => {
                if (typeof field.value === "string") field.onChange(stripPhone(field.value));
                field.onBlur();
              }}
            />
          </FormControl>
          {description ? (
            <FormDescription>{description}</FormDescription>
          ) : (
            <FormDescription>International format, digits only are stored.</FormDescription>
          )}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** CIDR / IP input with live validity hint; normalizes "1.2.3.4" → "1.2.3.4/32" on blur. */
export function CidrField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  disabled,
  placeholder = "203.0.113.0/24",
}: BaseProps<T> & { placeholder?: string }) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field, fieldState }) => {
        const value = typeof field.value === "string" ? field.value : "";
        const check = value ? checkCidr(value) : null;
        return (
          <FormItem className={className}>
            <FormLabel>{label}</FormLabel>
            <FormControl>
              <Input
                {...field}
                value={value}
                autoComplete="off"
                spellCheck={false}
                placeholder={placeholder}
                disabled={disabled}
                className="font-mono"
                onBlur={() => {
                  const c = checkCidr(value);
                  if (c.ok) field.onChange(c.normalized);
                  field.onBlur();
                }}
              />
            </FormControl>
            {!fieldState.error && check && !check.ok ? (
              <p className="text-[0.8rem] text-warning">{check.error}</p>
            ) : description ? (
              <FormDescription>{description}</FormDescription>
            ) : (
              <FormDescription>IPv4 or IPv6, single address or CIDR range.</FormDescription>
            )}
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

export function SubmitButton({
  pending,
  children,
  ...props
}: ButtonProps & { pending?: boolean }) {
  return (
    <Button type="submit" disabled={pending || props.disabled} {...props}>
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {children}
    </Button>
  );
}
