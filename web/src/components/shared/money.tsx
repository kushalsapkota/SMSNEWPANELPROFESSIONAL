"use client";

import { forwardRef, useEffect, useState, type InputHTMLAttributes } from "react";
import { Input } from "@/components/ui/input";
import { formatMoney, microsToDecimalString, parseMoneyToMicros } from "@/lib/money";
import { cn } from "@/lib/utils";

/** Read-only money display: micros → "$0.0050". */
export function Money({
  micros,
  currency = "USD",
  decimals = 4,
  className,
  signed,
}: {
  micros: number | null | undefined;
  currency?: string;
  decimals?: number;
  className?: string;
  /** color negative red / positive green and prefix "+" */
  signed?: boolean;
}) {
  const text = formatMoney(micros, currency, decimals);
  const positive = signed && typeof micros === "number" && micros > 0;
  return (
    <span
      className={cn(
        "tabular-nums",
        signed && typeof micros === "number" && micros < 0 && "text-destructive",
        positive && "text-success",
        className,
      )}
    >
      {positive ? "+" : ""}
      {text}
    </span>
  );
}

export interface MoneyInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> {
  /** Value in micros; null = empty. */
  value: number | null | undefined;
  onChange: (micros: number | null) => void;
  currency?: string;
  allowNegative?: boolean;
}

/**
 * Decimal currency input bound to a micros value. Accepts up to 6 decimals;
 * conversion is exact (string → bigint), never via floats.
 */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  { value, onChange, currency = "USD", allowNegative = false, className, onBlur, ...props },
  ref,
) {
  const [text, setText] = useState(() =>
    value === null || value === undefined ? "" : microsToDecimalString(value),
  );

  // Sync external value changes (form reset) without clobbering what is being typed.
  useEffect(() => {
    const current = parseMoneyToMicros(text);
    if ((value ?? null) !== current) {
      setText(value === null || value === undefined ? "" : microsToDecimalString(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className={cn("relative", className)}>
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-xs text-muted-foreground">
        {currency}
      </span>
      <Input
        ref={ref}
        inputMode="decimal"
        autoComplete="off"
        className="pl-12 tabular-nums"
        value={text}
        onChange={(e) => {
          const raw = e.target.value;
          const re = allowNegative ? /^-?[\d,]*\.?\d{0,6}$/ : /^[\d,]*\.?\d{0,6}$/;
          if (raw !== "" && !re.test(raw)) return;
          setText(raw);
          onChange(parseMoneyToMicros(raw));
        }}
        onBlur={(e) => {
          const m = parseMoneyToMicros(text);
          if (m !== null) setText(microsToDecimalString(m));
          onBlur?.(e);
        }}
        {...props}
      />
    </div>
  );
});
