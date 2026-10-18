import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap';
import { loadConfig } from './config/config';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error((e as Error).message);
    process.exit(1);
  }
  const app = await createApp();
  await app.listen(config.PORT);
  new Logger('Main').log(`api listening on :${config.PORT}`);
}

void main();
