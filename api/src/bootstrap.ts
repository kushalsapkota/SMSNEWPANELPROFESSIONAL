import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { loadConfig } from './config/config';
import { setupDocs } from './docs/swagger';
import { ProxyTrust, proxyTrustOf } from './common/request.util';

/** Shared by main.ts and the e2e tests so both run the exact same HTTP stack. */
export function configureApp(app: NestExpressApplication, trustProxy: ProxyTrust | null | false, opts: { docs?: boolean } = {}): INestApplication {
  app.disable('x-powered-by');
  // Keep req.ip consistent with clientIp(): only trusted proxy peers may set X-Forwarded-For.
  app.set('trust proxy', trustProxy ? (addr: string) => trustProxy.isTrusted(addr) : false);
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: false, limit: '2mb' }));
  app.enableShutdownHooks();
  if (opts.docs ?? true) setupDocs(app);
  return app;
}

export async function createApp(): Promise<NestExpressApplication> {
  const config = loadConfig(); // fail fast before anything connects
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, bufferLogs: true });
  configureApp(app, proxyTrustOf(config), { docs: config.SWAGGER_ENABLED });
  return app;
}
