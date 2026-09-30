// SPDX-License-Identifier: AGPL-3.0-only
//
// C58's endings loop: `pnpm endings [--once]` (ORCH46 ruling B, ORCH47).
//
// Runs on the environment's machine beside the forwarder, never on Vercel. It
// holds the owner's login (for the cross-business reads only), the application
// login (for each business's settle, under tenancy), `GOTRUE_URL` and the
// provider's admin key, `SUPABASE_SERVICE_KEY`. Every
// `ACCESS_ENDING_RETRY_SECONDS` it asks the provider for the steps each access
// ending still owes. Nothing here prints a setting's value or a fault's words.

import { connect, connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { goTrueLogins } from '../api/auth/provider-logins.ts';
import { ACCESS_ENDING_RETRY_SECONDS, endingsSettings, retryAccessEndings } from './pass.ts';

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const settings = endingsSettings(env);
  if (!settings.ok) {
    process.stderr.write(`endings: ${settings.problem}\n`);
    return 2;
  }
  const owner = connectAsAdmin(env['DATABASE_ADMIN_URL'] as string, { source: 'admin' });
  const app = connect(env['DATABASE_URL'] as string, { source: 'runtime' });
  const logins = goTrueLogins(settings.adminKey, env['GOTRUE_URL'] as string);
  try {
    for (;;) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one pass at a time, by design
        const owed = await retryAccessEndings(owner, app, logins);
        process.stdout.write(`${JSON.stringify({ owed })}\n`);
      } catch {
        process.stderr.write('endings: a pass failed; the next one retries\n');
      }
      if (argv.includes('--once')) return 0;
      // oxlint-disable-next-line no-await-in-loop -- the retry interval
      await new Promise<void>((done) => {
        setTimeout(done, ACCESS_ENDING_RETRY_SECONDS * 1000);
      });
    }
  } finally {
    await Promise.all([owner.close(), app.close()]);
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env);
