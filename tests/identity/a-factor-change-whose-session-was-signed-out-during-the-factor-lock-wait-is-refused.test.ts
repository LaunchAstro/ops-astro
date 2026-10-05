// SPDX-License-Identifier: AGPL-3.0-only
//
// Each second-factor act records its change in a second transaction that
// resolves the caller's session, then waits for the login's factor lock
// (`liveFactor` with `lock`), and resolves nothing after. A fixture
// transaction holds that lock; the act's record step is admitted on the live
// session and parks on the lock; the session is signed out on another
// connection and commits; then the fixture lets go. The act must be refused
// `AUTH_SESSION_EXPIRED`: no factor enrolled, verified or removed, and nothing
// removed at the provider.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import {
  enrolSecondFactor,
  removeSecondFactor,
  verifySecondFactor,
  type FactorCaller,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import { signOutSession } from '../../packages/core-commands/src/commands/account-sessions.ts';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  liveFactor,
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
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
import { hold, waitingOn } from '../support/lock-waits.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from './fixture.ts';

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

/** A provider that answers every call as done, and records each factor it removes. */
function provider(removed: string[]): FactorProvider {
  return {
    enrol: () =>
      Promise.resolve({
        ok: true,
        value: {
          factorId: `factor-${randomUUID()}`,
          qrCode: 'local qr',
          secret: 'local secret',
          uri: 'otpauth:',
        },
      }),
    verify: () =>
      Promise.resolve({
        ok: true,
        value: { accessToken: 'local-elevated-bearer', refreshToken: 'local', expiresIn: 3600 },
      }),
    remove: (_token, factorId) => {
      removed.push(factorId);
      return Promise.resolve({ ok: true, value: undefined });
    },
    signOut: () => Promise.resolve({ ok: true, value: undefined }),
  };
}

/** A member signed in a moment ago with a password, holding a verified factor unless enrolling. */
async function caller(verified: boolean): Promise<{ caller: FactorCaller; person: string }> {
  const subject = `factor-${randomUUID()}`;
  const person = await db.app.withBusiness(business, async (tx) => {
    const personId = await insertPerson(tx, 'Factor holder');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    if (verified) {
      const factor = await recordFactorEnrolled(tx, {
        personId,
        provider: 'supabase',
        providerFactorId: `factor-${randomUUID()}`,
      });
      await recordFactorVerified(tx, { personId, factorId: factor.id, subject });
    }
    return personId;
  });
  return {
    person,
    caller: {
      database: db.app,
      businessId: business,
      accessToken: 'local-test-bearer',
      presented: {
        provider: 'supabase',
        subject,
        sessionId: randomUUID(),
        assurance: { level: 'aal1', signedInAt: Math.floor(Date.now() / 1000) - 2, factorAt: null },
      },
    },
  };
}

const ACTS = {
  enrol: (on: FactorCaller, to: FactorProvider) => enrolSecondFactor(on, to),
  verify: (on: FactorCaller, to: FactorProvider) => verifySecondFactor(on, { code: '123456' }, to),
  remove: (on: FactorCaller, to: FactorProvider) => removeSecondFactor(on, { code: '123456' }, to),
} as const;

it.each(['enrol', 'verify', 'remove'] as const)(
  'a factor %s whose session was signed out during the factor lock wait is refused, and changes nothing',
  async (act) => {
    const { caller: asked, person } = await caller(act !== 'enrol');
    const removed: string[] = [];
    const to = provider(removed);
    const digest = createHash('sha256').update(asked.presented.subject).digest('hex');
    const actor = connect(db.appUrl);
    const other = connect(db.appUrl);
    try {
      const factorLock = await hold(db.appUrl, business, async (tx) => {
        await advisoryLock(tx, `second-factor-subject:${digest}`);
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
