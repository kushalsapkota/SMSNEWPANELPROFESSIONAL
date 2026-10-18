import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Fresh, fully migrated test DB (default sms_api2) for the whole run; its Redis DB (default 5) flushed. */
export default async function globalSetup(): Promise<void> {
  const script = path.resolve(__dirname, '../../db/reset-db.sh');
  execFileSync(script, [process.env.TEST_DB_NAME ?? 'sms_api2'], { stdio: 'inherit' });
  execFileSync('redis-cli', ['-p', '6399', '-n', process.env.TEST_REDIS_DB ?? '5', 'FLUSHDB'], { stdio: 'ignore' });
}
