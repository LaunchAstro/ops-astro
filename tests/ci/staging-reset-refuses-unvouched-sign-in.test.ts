// SPDX-License-Identifier: AGPL-3.0-only
// The reset keeps the provider's sign-ins, so it empties a marked database
// only while the guard vouches for every one of them: a sign-in that is not a
// made-up address, noted by the guard, is refused before anything is emptied.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  canaryHolds,
  onDatabase,
  plantCanary,
  quiet,
  run,
  serverUrl,
  settings,
  stagingResetHooks,
} from './s0-1-staging-reset.fixture.ts';

stagingResetHooks();

it.skipIf(serverUrl === undefined)(
  'staging reset refuses a marked database holding a sign-in that is not made-up',
  async () => {
    const first = await run(settings());
    expect(first.status, `precondition: the first reset finishes\n${first.out}`).toBe(0);

    await onDatabase((admin) =>
      admin.execute('insert into auth.users (id, email) values ($1, $2)', [
        randomUUID(),
        'owner.canary@example.net',
      ]),
    );
    await plantCanary();
    const env = settings();
    const again = await run(env);

    expect(again.status, again.out).toBe(1);
    expect(again.out).toContain('cannot vouch for a sign-in');
    expect(again.out).not.toContain('owner.canary');
    quiet(again);
    expect(existsSync(env['OPS_SEED_DIR'] ?? '')).toBe(false);
    expect(existsSync(env['OPS_ASTRO_DEPLOYMENTS'] ?? ''), 'a refusal records nothing').toBe(false);
    expect(await canaryHolds()).toBe(true);
  },
  360_000,
);
