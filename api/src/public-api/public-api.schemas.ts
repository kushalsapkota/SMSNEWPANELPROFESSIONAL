import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/** Hand-written OpenAPI schemas for /v1 (zod schemas are the runtime source of truth). */
export const ERROR_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['error_code', 'message'],
  properties: {
    error_code: { type: 'string', example: 'INSUFFICIENT_FUNDS' },
    message: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
  },
};

export const SEND_BODY_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['to', 'from', 'text'],
  properties: {
    to: {
      oneOf: [
        { type: 'string', example: '+91 98765 43210' },
        { type: 'array', items: { type: 'string' }, maxItems: 1000 },
      ],
    },
    from: { type: 'string', example: 'MYBANK', description: 'Alphanumeric (≤11) or numeric sender' },
    text: { type: 'string', example: 'Your code is 849201' },
    client_ref: { type: 'string', maxLength: 64, description: 'Your own reference, echoed in DLR webhooks' },
  },
};

export const SEND_RESPONSE_SCHEMA: SchemaObject = {
  type: 'object',
  properties: {
    messages: {
      type: 'array',
      items: {
        oneOf: [
          {
            type: 'object',
            properties: {
              to: { type: 'string' },
              message_id: { type: 'string', format: 'uuid' },
              status: { type: 'string', example: 'ACCEPTED' },
              parts: { type: 'integer' },
              cost_micros: { type: 'integer' },
            },
          },
          { type: 'object', properties: { to: { type: 'string' }, error_code: { type: 'string' }, message: { type: 'string' } } },
        ],
      },
    },
  },
};

export const MESSAGE_STATUS_SCHEMA: SchemaObject = {
  type: 'object',
  properties: {
    message_id: { type: 'string', format: 'uuid' },
    to: { type: 'string' },
    from: { type: 'string', nullable: true },
    status: { type: 'string', example: 'DELIVERED' },
    dlr_stat: { type: 'string', nullable: true, example: 'DELIVRD' },
    parts: { type: 'integer' },
    cost_micros: { type: 'integer', nullable: true, description: 'What the message cost you: 0 once fully refunded (failed before/at submission); reduced by partial refunds.' },
    refunded: { type: 'boolean', description: 'true when the charge was refunded (message failed before or at submission)' },
    created_at: { type: 'string', format: 'date-time' },
    submitted_at: { type: 'string', format: 'date-time', nullable: true },
    done_at: { type: 'string', format: 'date-time', nullable: true },
    client_ref: { type: 'string', nullable: true },
  },
};
