// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { requireOperatingOperator } from '../../scripts/ops/operator.ts';
import { signBearer, TEST_ISSUER } from '../support/sign-in.ts';
import {
  keySet,
  onDatabase,
  own,
  run,
  runner,
  serverUrl,
  settings,
  stagingResetHooks,
  users,
} from '../ci/s0-1-staging-reset.fixture.ts';

stagingResetHooks();

it.skipIf(serverUrl === undefined)(
  'staging reset cannot revive an already revoked operator session',
  async () => {
    expect((await run(settings())).status, 'the first reset must finish').toBe(0);
    const session = randomUUID();
    const subject = users.get('olive@alpha.local');
    expect(subject).toBeDefined();
    const bearer = await signBearer({
      sub: subject, aud: 'authenticated', iss: TEST_ISSUER,
      role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600, session_id: session,
    });
    const environment = {
      DATABASE_ADMIN_URL: own,
      DATABASE_URL: runner,
      GOTRUE_URL: TEST_ISSUER,
      SUPABASE_KEY_SET_URL: keySet?.url ?? '',
      OPS_ASTRO_TOKEN: bearer,
      OPS_ASTRO_BUSINESS: 'alpha',
      OPS_ASTRO_DEPLOYMENTS: settings()['OPS_ASTRO_DEPLOYMENTS'],
    };
    expect((await requireOperatingOperator(environment)).ok, 'positive control: the live session holds the operator grant').toBe(true);
    await onDatabase((admin) => admin.execute(
      'insert into ops.ended_provider_sessions (session_id) values ($1)', [session],
    ));
    expect((await requireOperatingOperator(environment)).ok, 'the committed revocation takes effect').toBe(false);
    expect((await run(settings())).status, 'the repeated reset must finish').toBe(0);
    expect(users.get('olive@alpha.local'), 'the provider subject is preserved').toBe(subject);
    expect((await requireOperatingOperator(environment)).ok, 'the same revoked bearer must remain refused after reset').toBe(false);
  },
  180_000,
);
