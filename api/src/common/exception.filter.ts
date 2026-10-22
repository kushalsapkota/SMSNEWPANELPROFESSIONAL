import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { AppError, ErrorCode } from './errors';

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
  message: string;
  table?: string;
  column?: string;
}

function isPgError(e: unknown): e is PgError {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as PgError).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((e as PgError).code as string) &&
    'severity' in e
  );
}

/** Maps Postgres errors that can legitimately be caused by client input. */
export function mapPgError(e: PgError): AppError | null {
  const details: Record<string, unknown> = {};
  if (e.constraint) details.constraint = e.constraint;
  switch (e.code) {
    case '23505':
      return AppError.conflict('A record with the same unique value already exists', {
        ...details,
        ...(e.detail ? { detail: e.detail } : {}),
      });
    case '23503':
      return AppError.invalid('Referenced record does not exist', details);
    case '23514':
    case '23502':
    case '22001':
    case '22003':
    case '22P02':
    case '22007':
    case '22008':
      return AppError.invalid(e.message, details);
    case 'P0001': // RAISE EXCEPTION from integrity triggers
      return AppError.invalid(e.message, details);
    case '42501': // RLS WITH CHECK violation
      return AppError.forbidden('Row-level security denied this operation');
    default:
      return null;
  }
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toResponse(exception);
    if (status >= 500) {
      if (exception instanceof AppError) this.logger.warn(`${exception.code}: ${exception.message}`);
      else this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    if (body.error_code === 'RATE_LIMITED') {
      const retry = (body.details as { retry_after_seconds?: unknown } | undefined)?.retry_after_seconds;
      res.setHeader('Retry-After', String(typeof retry === 'number' && retry > 0 ? Math.ceil(retry) : 1));
    }
    res.status(status).json(body);
  }

  toResponse(exception: unknown): {
    status: number;
    body: { error_code: ErrorCode; message: string; details?: Record<string, unknown> };
  } {
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        body: {
          error_code: exception.code,
          message: exception.message,
          ...(exception.details ? { details: exception.details } : {}),
        },
      };
    }
    if (isPgError(exception)) {
      const mapped = mapPgError(exception);
      if (mapped) return this.toResponse(mapped);
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code: ErrorCode =
        status === HttpStatus.NOT_FOUND
          ? 'NOT_FOUND'
          : status === HttpStatus.UNAUTHORIZED
            ? 'UNAUTHORIZED'
            : status === HttpStatus.FORBIDDEN
              ? 'FORBIDDEN'
              : status === HttpStatus.TOO_MANY_REQUESTS
                ? 'RATE_LIMITED'
                : status === HttpStatus.CONFLICT
                  ? 'CONFLICT'
                  : status < 500
                    ? 'INVALID_REQUEST'
                    : 'INTERNAL';
      const resp = exception.getResponse();
      const message =
        typeof resp === 'string'
          ? resp
          : typeof (resp as { message?: unknown }).message === 'string'
            ? ((resp as { message: string }).message as string)
            : exception.message;
      return { status, body: { error_code: code, message } };
    }
    // body-parser errors (malformed JSON, payload too large) carry status/type.
    if (typeof exception === 'object' && exception !== null && 'type' in exception && 'status' in exception) {
      const status = Number((exception as { status: unknown }).status);
      if (status >= 400 && status < 500) {
        return {
          status,
          body: { error_code: 'INVALID_REQUEST', message: (exception as unknown as Error).message || 'Malformed request body' },
        };
      }
    }
    return { status: 500, body: { error_code: 'INTERNAL', message: 'Internal server error' } };
  }
}
