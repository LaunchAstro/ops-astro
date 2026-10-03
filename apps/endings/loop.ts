// SPDX-License-Identifier: AGPL-3.0-only
//
// C58's endings loop, run by `apps/endings/main.ts` (`pnpm endings [--once]`).
//
// Runs on the environment's machine beside the forwarder, never on Vercel. It
// holds the owner's login (for the cross-business reads only), the application
// login (for each business's settle, under tenancy), `GOTRUE_URL` and the
// provider's admin key, `SUPABASE_SERVICE_KEY`. Every
// `ACCESS_ENDING_RETRY_SECONDS` it asks the provider for the steps each access
// ending and each factor reset (C59) still owes; `--once` runs one pass and
// exits 1 if that pass failed: it could not finish, or a step it asked ended
// on a fault and is still owed.
// Nothing here prints a setting's value or a fault's words.

import { connect, connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { goTrueLogins } from '../api/auth/provider-logins.ts';
import { ACCESS_ENDING_RETRY_SECONDS, endingsSettings, retryOwedSteps } from './pass.ts';

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const settings = endingsSettings(env);
  if (!settings.ok) {
    process.stderr.write(`endings: ${settings.problem}\n`);
    return 2;
  }
  let app, owner;
  try {
    owner = connectAsAdmin(env['DATABASE_ADMIN_URL'] as string, { source: 'admin' });
    app = connect(env['DATABASE_URL'] as string, { source: 'runtime' });
  } catch {
    // What postgres.js threw may carry the string; only the setting names leave.
    process.stderr.write('endings: DATABASE_URL or DATABASE_ADMIN_URL could not be opened\n');
    return 2;
  }
  const logins = goTrueLogins(settings.adminKey, env['GOTRUE_URL'] as string);
  try {
    for (;;) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one pass at a time, by design
        const pass = await retryOwedSteps(owner, app, logins);
        process.stdout.write(`${JSON.stringify({ owed: pass.owed })}\n`);
        if (pass.faults > 0 && argv.includes('--once')) {
          process.stderr.write('endings: a provider step failed and is still owed\n');
          return 1;
        }
      } catch {
        if (argv.includes('--once')) {
          process.stderr.write('endings: the pass failed\n');
          return 1;
        }
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
