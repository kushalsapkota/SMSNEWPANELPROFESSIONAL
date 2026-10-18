import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Fresh, fully migrated sms_api2 DB for the whole run; Redis DB 5 flushed. */
export default async function globalSetup(): Promise<void> {
  const script = path.resolve(__dirname, '../../db/reset-db.sh');
  execFileSync(script, ['sms_api2'], { stdio: 'inherit' });
  execFileSync('redis-cli', ['-p', '6399', '-n', '5', 'FLUSHDB'], { stdio: 'ignore' });
}
