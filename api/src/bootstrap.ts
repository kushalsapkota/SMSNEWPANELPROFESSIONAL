import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { loadConfig } from './config/config';
import { setupDocs } from './docs/swagger';

/** Shared by main.ts and the e2e tests so both run the exact same HTTP stack. */
export function configureApp(app: NestExpressApplication, trustProxy: boolean, opts: { docs?: boolean } = {}): INestApplication {
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: false, limit: '2mb' }));
  app.enableShutdownHooks();
  if (opts.docs ?? true) setupDocs(app);
  return app;
}

export async function createApp(): Promise<NestExpressApplication> {
  const config = loadConfig(); // fail fast before anything connects
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, bufferLogs: true });
  configureApp(app, config.TRUST_PROXY, { docs: config.SWAGGER_ENABLED });
  return app;
}
