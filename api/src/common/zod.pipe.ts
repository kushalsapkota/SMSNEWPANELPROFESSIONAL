import { PipeTransform } from '@nestjs/common';
import { ZodError, ZodTypeAny, z } from 'zod';
import { AppError } from './errors';

export function zodDetails(err: ZodError): Record<string, unknown> {
  return {
    issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
  };
}

/** Parses with a zod schema; throws INVALID_REQUEST with per-field details. */
export function parseOrThrow<S extends ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw AppError.invalid('Request validation failed', zodDetails(r.error));
  return r.data;
}

/** `@Body(new ZodPipe(schema))` / `@Query(new ZodPipe(schema))`. */
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    return parseOrThrow(this.schema, value);
  }
}
