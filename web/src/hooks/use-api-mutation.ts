"use client";

import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";

export interface ApiMutationOptions<TData, TVars> {
  mutationFn: (vars: TVars) => Promise<TData>;
  /** Success toast text; false (or a function returning null) = no toast. */
  success?: string | false | ((data: TData, vars: TVars) => string | null);
  /** Prefix keys to invalidate after success (e.g. [qk.orgs.all]). */
  invalidate?: QueryKey[];
  onSuccess?: (data: TData, vars: TVars) => void | Promise<void>;
  onError?: (error: unknown, vars: TVars) => void;
  /** Error toast prefix, default "Action failed". false = handle errors yourself. */
  errorTitle?: string | false;
}

/**
 * Every panel mutation goes through this hook: it shows a success / error
 * toast and invalidates the affected queries, so the UI never shows stale
 * data after a write.
 */
export function useApiMutation<TData = unknown, TVars = void>(opts: ApiMutationOptions<TData, TVars>) {
  const queryClient = useQueryClient();
  return useMutation<TData, unknown, TVars>({
    mutationFn: opts.mutationFn,
    onSuccess: async (data, vars) => {
      if (opts.invalidate?.length) {
        await Promise.all(
          opts.invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        );
      }
      if (opts.success !== false && opts.success !== undefined) {
        const text = typeof opts.success === "function" ? opts.success(data, vars) : opts.success;
        if (text) toast.success(text);
      }
      await opts.onSuccess?.(data, vars);
    },
    onError: (error, vars) => {
      if (opts.errorTitle !== false) {
        toast.error(opts.errorTitle ?? "Action failed", { description: errorMessage(error) });
      }
      opts.onError?.(error, vars);
    },
  });
}
