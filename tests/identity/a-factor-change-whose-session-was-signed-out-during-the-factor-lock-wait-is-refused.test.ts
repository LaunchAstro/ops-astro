// SPDX-License-Identifier: AGPL-3.0-only
//
// Each second-factor act records its change in a second transaction that
// resolves the caller's session, then waits for the login's factor lock
// (`liveFactor` with `lock`) and the audit chain, and asks the session again
// after its last wait (`judged`). A fixture
// transaction holds that lock; the act's record step is admitted on the live
// session and parks on the lock; the session is signed out on another
// connection and commits; then the fixture lets go. The act must be refused
// `AUTH_SESSION_EXPIRED`: no factor enrolled, verified or removed, and nothing
// removed at the provider.

import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import { signOutSession } from '../../packages/core-commands/src/commands/account-sessions.ts';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import { liveFactor } from '../../packages/core-records/src/identity/second-factor.ts';
import {
  advisoryLock,
  connect,
  type BusinessId,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { gate, hold, waitingOn } from '../support/lock-waits.ts';
import { insertBusiness } from './fixture.ts';
import {
  ACTS,
  factorCaller,
  factorLockKey,
  provider,
  standingElsewhere,
} from './factor-lock-wait-fixture.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;

let db: FreshDatabase;
let business: BusinessId;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  db = await createFreshDatabase({ part: 'factorsignout' });
  business = (await insertBusiness(db.app, 'factor-sign-out')) as BusinessId;
}, 180_000);
afterAll(async () => {
  await db?.drop();
});

const caller = (verified: boolean) => factorCaller(db, business, verified);

it.each(['enrol', 'verify', 'remove'] as const)(
  'a factor %s whose session was signed out during the factor lock wait is refused, and changes nothing',
  async (act) => {
    const { caller: asked, person } = await caller(act !== 'enrol');
    const removed: string[] = [];
    const to = provider(removed);
    const actor = connect(db.appUrl);
    const other = connect(db.appUrl);
    try {
      const factorLock = await hold(db.appUrl, business, async (tx) => {
        await advisoryLock(tx, factorLockKey(asked.presented.subject));
      });
      let acting: ReturnType<(typeof ACTS)[typeof act]> | undefined;
      try {
        acting = ACTS[act]({ ...asked, database: actor }, to);
        await waitingOn(db.admin, 'advisory', 'pg_advisory_xact_lock');
        expect(await signOutSession({ ...asked, database: other }, {}, to)).toEqual({
          ended: 1,
          signedOutAtProvider: true,
        });
        expect(
          await other.withBusiness(business, (tx) =>
            resolveLogin(tx, asked.presented, 'enrolling'),
          ),
        ).toMatchObject({ refused: true, code: 'AUTH_SESSION_EXPIRED' });
      } finally {
        await factorLock.letGo();
      }
      const result = await acting;
      const live = await db.app.withBusiness(business, (tx) => liveFactor(tx, person));
      expect({ result, status: live?.status ?? 'none', removed }).toMatchObject({
        result: { refused: true, code: 'AUTH_SESSION_EXPIRED' },
        status: act === 'enrol' ? 'none' : 'verified',
        removed: [],
      });
    } finally {
      await Promise.all([actor.close(), other.close()]);
    }
  },
);

// Sol round 1 on #1010, F2: the removal's last wait is its audit insert, on
// the business's audit chain lock. The same login and session also stand in a
// second business, where the sign-out runs, so the sign-out's own audit event
// does not queue behind the held chain.
it('a factor removal whose session was signed out during the audit wait is refused, and removes nothing', async () => {
  const { caller: asked, person } = await caller(true);
  const { business: elsewhere } = await standingElsewhere(db, asked.presented.subject);
  const removed: string[] = [];
  const verifying = gate();
  const verified = gate();
  const to: FactorProvider = {
    ...provider(removed),
    verify: async () => {
      verifying.release();
      await verified.promise;
      return {
        ok: true,
        value: { accessToken: 'local-elevated', refreshToken: 'local', expiresIn: 3600 },
      };
    },
  };
  const actor = connect(db.appUrl);
  const other = connect(db.appUrl);
  try {
    const removing = ACTS.remove({ ...asked, database: actor }, to);
    await verifying.promise;
    const chain = await hold(db.appUrl, business, async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1::text, 0))', [business]);
    });
    try {
      verified.release();
      await waitingOn(db.admin, 'advisory', 'insert into audit_events');
      expect(
        await signOutSession({ ...asked, businessId: elsewhere, database: other }, {}, to),
      ).not.toMatchObject({ refused: true });
    } finally {
      await chain.letGo();
    }
    const result = await removing;
    const live = await db.app.withBusiness(business, (tx) => liveFactor(tx, person));
    expect({ result, status: live?.status ?? 'none', removed }).toMatchObject({
      result: { refused: true, code: 'AUTH_SESSION_EXPIRED' },
      status: 'verified',
      removed: [],
    });
  } finally {
    verified.release();
    await Promise.all([actor.close(), other.close()]);
  }
});
