import { HttpStatus } from '@nestjs/common';

/** CONTRACTS §4 shared error enum. */
export const ERROR_CODES = [
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'IP_NOT_ALLOWED',
  'ACCOUNT_SUSPENDED',
  'SENDING_DISABLED',
  'CHANNEL_DISABLED',
  'INSUFFICIENT_FUNDS',
  'RATE_LIMITED',
  'DAILY_LIMIT',
  'MONTHLY_LIMIT',
  'ROUTE_NOT_FOUND',
  'SENDER_NOT_ALLOWED',
  'OTP_NOT_FOUND',
  'DESTINATION_BLOCKED',
  'CONTENT_BLOCKED',
  'INVALID_DESTINATION',
  'MESSAGE_TOO_LONG',
  'NOT_FOUND',
  'CONFLICT',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Same mapping as the engine (CONTRACTS-CHANGES engine-core #12): 422 for business rejections. */
const DEFAULT_STATUS: Record<ErrorCode, number> = {
  INVALID_REQUEST: HttpStatus.BAD_REQUEST,
  UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  IP_NOT_ALLOWED: HttpStatus.FORBIDDEN,
  ACCOUNT_SUSPENDED: HttpStatus.UNPROCESSABLE_ENTITY,
  SENDING_DISABLED: HttpStatus.UNPROCESSABLE_ENTITY,
  CHANNEL_DISABLED: HttpStatus.UNPROCESSABLE_ENTITY,
  INSUFFICIENT_FUNDS: HttpStatus.UNPROCESSABLE_ENTITY,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  DAILY_LIMIT: HttpStatus.UNPROCESSABLE_ENTITY,
  MONTHLY_LIMIT: HttpStatus.UNPROCESSABLE_ENTITY,
  ROUTE_NOT_FOUND: HttpStatus.UNPROCESSABLE_ENTITY,
  SENDER_NOT_ALLOWED: HttpStatus.UNPROCESSABLE_ENTITY,
  OTP_NOT_FOUND: HttpStatus.UNPROCESSABLE_ENTITY,
  DESTINATION_BLOCKED: HttpStatus.UNPROCESSABLE_ENTITY,
  CONTENT_BLOCKED: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_DESTINATION: HttpStatus.UNPROCESSABLE_ENTITY,
  MESSAGE_TOO_LONG: HttpStatus.UNPROCESSABLE_ENTITY,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
};

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v);
}

/**
 * The only error type services should throw. Rendered by AppExceptionFilter as
 * `{ error_code, message, details? }` with `status` (defaults per code).
 */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    status?: number,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status ?? DEFAULT_STATUS[code];
  }

  static invalid(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('INVALID_REQUEST', message, details);
  }
  static unauthorized(message = 'Authentication required', details?: Record<string, unknown>): AppError {
    return new AppError('UNAUTHORIZED', message, details);
  }
  static forbidden(message = 'You are not allowed to perform this action'): AppError {
    return new AppError('FORBIDDEN', message);
  }
  static notFound(what = 'Resource'): AppError {
    return new AppError('NOT_FOUND', `${what} not found`);
  }
  /** Panel/session access refused because the org (or its reseller) is suspended. */
  static suspended(): AppError {
    return new AppError('ACCOUNT_SUSPENDED', 'Your account is suspended', undefined, HttpStatus.FORBIDDEN);
  }
  static conflict(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('CONFLICT', message, details);
  }
  static internal(message = 'Internal error', details?: Record<string, unknown>, status?: number): AppError {
    return new AppError('INTERNAL', message, details, status);
  }
}
