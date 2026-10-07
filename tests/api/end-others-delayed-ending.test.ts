// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { ACCEPTANCE_ISSUER, bearer, call, personPath } from '../acceptance/world.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { testSignIn } from '../support/sign-in.ts';
import { latch } from './api-2-agent-credential-use-world.ts';
import {
  EXPIRED,
  OK,
  now,
  served,
  tokenFor,
  useSessionsWorld,
  world,
} from './c58-sessions-world.ts';

useSessionsWorld();

type Latch = ReturnType<typeof latch>;

// The app pool, its subject-wide ending insert held 62 s of real database time, then until released.
function endingHeld(pool: Database, ready: Latch, release: Latch): Database {
  return {
    ...pool,
    withBusiness: async (businessId, run) =>
      await pool.withBusiness(
        businessId,
        async (tx) =>
          await run({
            ...tx,
            query: async <Row>(text: string, parameters?: readonly unknown[]) => {
              if (text.includes('insert into ops.ended_subject_sessions')) {
                // Real elapsed database time, with no changed rows or clock mocks.
                // Any lock wait can leave transaction_timestamp this far behind.
                await tx.query('select pg_sleep(62)');
                ready.open();
                await release.promise;
              }
              return await tx.query<Row>(text, parameters);
            },
          }),
      ),
  };
}

const factors: FactorProvider = {
  verifiedFactors: () => Promise.resolve({ ok: true, value: [] }),
  enrol: () => Promise.resolve({ ok: false, fault: 'unreachable' }),
  verify: () => Promise.resolve({ ok: false, fault: 'unreachable' }),
  remove: () => Promise.resolve({ ok: false, fault: 'unreachable' }),
  signOut: () => Promise.resolve({ ok: true, value: undefined }),
};

function apiOver(database: Database): ReturnType<typeof createApi> {
  const byKey: Readonly<Record<string, string>> = { alpha: world.alpha, bravo: world.bravo };
  return createApi({
    database,
    verify: createSupabaseVerifier(testSignIn(ACCEPTANCE_ISSUER)),
    resolveBusiness: (key) => Promise.resolve(byKey[key]),
    executeCommand,
    executeRead,
    factors,
  });
}

it('a delayed end-others transaction revokes a session signed in before its ending commits in another business', async () => {
  const subject = world.mia.subject;
  await world.db.app.withBusiness(world.bravo, async (tx) => {
    const personId = await insertPerson(tx, 'Sol delayed-ending person in bravo');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    await grantTo(tx, { personId, actorId, presented: { provider: 'supabase', subject } }, 'read');
  });
  const kept = await tokenFor(subject, randomUUID(), undefined, now() + 600, now() - 60);
  expect(await served(kept)).toEqual(OK);
  const ready = latch();
  const release = latch();
  const pool = connect(world.db.appUrl, { max: 2 });
  const api = apiOver(endingHeld(pool, ready, release));
  const ending = call(api, personPath('alpha', '/account/sessions/end-others'), {}, bearer(kept));
  try {
    await ready.promise;
    const other = await tokenFor(subject, randomUUID(), undefined, now() + 600, now());
    expect(await served(other, 'bravo'), 'the other business served it before the ending').toEqual(
      OK,
    );
    release.open();
    const ended = await ending;
    expect(ended.status).toBe(200);
    expect(ended.body['signedOutAtProvider']).toBe(true);
    expect(await served(kept), 'the kept session stays served').toEqual(OK);
    expect(
      await served(other, 'bravo'),
      'a session live before the committed ending is over',
    ).toEqual(EXPIRED);
  } finally {
    release.open();
    await ending.finally(async () => await pool.close());
  }
}, 90_000);
