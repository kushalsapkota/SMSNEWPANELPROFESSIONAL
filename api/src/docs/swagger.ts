import type { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { IS_PUBLIC } from '../common/decorators';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'] as const;

/** `${ControllerClass}_${method}` (swagger's default operationId) → handler is @Public(). */
function publicHandlers(app: INestApplication): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const type = wrapper.metatype as (new (...args: unknown[]) => unknown) | null;
      if (!type?.prototype) continue;
      const classPublic = Reflect.getMetadata(IS_PUBLIC, type) === true;
      for (const name of Object.getOwnPropertyNames(type.prototype)) {
        if (name === 'constructor') continue;
        const fn = (type.prototype as Record<string, unknown>)[name];
        if (typeof fn !== 'function') continue;
        out.set(`${type.name}_${name}`, classPublic || Reflect.getMetadata(IS_PUBLIC, fn) === true);
      }
    }
  }
  return out;
}

/**
 * OpenAPI document for the management API (/api, JWT) and the public API (/v1, API key).
 * Untagged management routes are grouped by their first path segment; security is derived
 * from the same @Public() metadata the guards use.
 */
export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('SMS Gateway API')
    .setDescription(
      [
        'Management REST API (`/api/*`, Bearer access JWT from `POST /api/auth/login`) and the public client API',
        '(`/v1/*`, API key as `Authorization: Bearer sk_live_…` or `X-API-Key`; legacy `?api_key=` on GET).',
        'Money is integer micros (1 currency unit = 1,000,000). Errors: `{error_code, message, details?}`.',
      ].join(' '),
    )
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Access token (15 min)' }, 'access-token')
    .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'API key sk_live_…' }, 'bearer-api-key')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-API-Key' }, 'x-api-key')
    .build();
  const doc = SwaggerModule.createDocument(app, config);
  const isPublic = publicHandlers(app);

  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      if (!op.tags || op.tags.length === 0) {
        const seg = /^\/api\/([^/]+)/.exec(path)?.[1];
        op.tags = [seg ?? 'other'];
      }
      if (path.startsWith('/v1/')) {
        op.security = [{ 'bearer-api-key': [] }, { 'x-api-key': [] }];
      } else if (!isPublic.get(op.operationId ?? '')) {
        op.security = [{ 'access-token': [] }];
      } else {
        op.security = [];
      }
    }
  }
  return doc;
}

/** Swagger UI at /api/docs, JSON at /api/docs-json. */
export function setupDocs(app: INestApplication): void {
  SwaggerModule.setup('api/docs', app, buildOpenApi(app), {
    jsonDocumentUrl: 'api/docs-json',
    swaggerOptions: { persistAuthorization: true },
    customSiteTitle: 'SMS Gateway API',
  });
}
