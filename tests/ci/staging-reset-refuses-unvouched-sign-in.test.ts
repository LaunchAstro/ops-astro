// SPDX-License-Identifier: AGPL-3.0-only
// The reset keeps the provider's sign-ins, so it empties a marked database
// only while the guard vouches for every one of them, and keeps the guard and
// its notes on sign-ins through the reset: a sign-in that is not a made-up
// address, noted before or during a run, and a guard switched off or dropped,
// are refused before anything is emptied.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  beforeNextCall,
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

const REAL = 'owner.canary@example.net';
const plantReal = async (): Promise<unknown> =>
  await onDatabase((admin) =>
    admin.execute('insert into auth.users (id, email) values ($1, $2)', [randomUUID(), REAL]),
  );
const onAuthUsers = async (statement: string): Promise<unknown> =>
  await onDatabase((admin) => admin.execute(statement));

async function refusedKeepingAll(): Promise<void> {
  await plantCanary();
  const env = settings();
  const result = await run(env);
  expect(result.status, result.out).toBe(1);
  expect(result.out).toContain('cannot vouch for a sign-in');
  expect(result.out).not.toContain('owner.canary');
  quiet(result);
  expect(existsSync(env['OPS_SEED_DIR'] ?? '')).toBe(false);
  expect(existsSync(env['OPS_ASTRO_DEPLOYMENTS'] ?? ''), 'a refusal records nothing').toBe(false);
  expect(await canaryHolds()).toBe(true);
}

it.skipIf(serverUrl === undefined)(
  'staging reset keeps a real sign-in noted before or during a run, and refuses the database',
  async () => {
    const first = await run(settings());
    expect(first.status, `precondition: the first reset finishes\n${first.out}`).toBe(0);

    // Noted after the reset's own check, before it empties: the seed still refuses.
    beforeNextCall.work = plantReal;
    const during = await run(settings());
    expect(during.status, during.out).toBe(1);
    expect(during.out).toContain('it holds a sign-in that is not a made-up address');
    expect(during.out).not.toContain('owner.canary');

    await refusedKeepingAll();
  },
  360_000,
);

it.skipIf(serverUrl === undefined)(
  'staging reset refuses a database whose sign-in guard was switched off or dropped',
  async () => {
    // The owner's repair after the case above: the real sign-in and its note gone.
    await onAuthUsers(`delete from auth.users where email = '${REAL}'`);
    await onAuthUsers('delete from ops_astro_made_up.untrusted');
    const repaired = await run(settings());
    expect(repaired.status, `precondition: the repaired database resets\n${repaired.out}`).toBe(0);

    await onAuthUsers('alter table auth.users disable trigger ops_astro_made_up_guard');
    await refusedKeepingAll();

    await onAuthUsers('alter table auth.users enable always trigger ops_astro_made_up_guard');
    await onAuthUsers('delete from ops_astro_made_up.untrusted');
    await onAuthUsers('drop trigger ops_astro_made_up_guard on auth.users');
    await refusedKeepingAll();
  },
  360_000,
);
