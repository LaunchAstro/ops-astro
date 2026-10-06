// SPDX-License-Identifier: AGPL-3.0-only
//
// A factor act's record step asks the session again after its last wait
// (`judged`), and a sign-out meanwhile undoes the act: whatever the act
// decided, a refusal included, is rolled back and AUTH_SESSION_EXPIRED is
// recorded in its place. Undoing it must take back only the act: a losing
// enrolment's removal goes, here and at the provider, and the permanent
// ending of a session refused while a reset is open stays.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import type { FactorCaller } from '../../packages/core-commands/src/commands/account-factor.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import { signOutSession } from '../../packages/core-commands/src/commands/account-sessions.ts';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  openResetWindow,
  settleResetWindow,
} from '../../packages/core-records/src/identity/sessions.ts';
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
  db = await createFreshDatabase({ part: 'factorundone' });
  business = (await insertBusiness(db.app, 'factor-undone')) as BusinessId;
}, 180_000);
afterAll(async () => {
  await db?.drop();
});

const caller = (verified: boolean) => factorCaller(db, business, verified);

// A verify whose unverified enrolment loses, under the factor lock, to the
// login's factor in another business: the lock's holder verifies that factor,
// and the session is signed out from that business while the verify waits.
// The loss is an act too (the enrolment removed here and at the provider), so
// the session asked after the wait refuses it like any other.
it('a verify that loses to a factor verified elsewhere, its session signed out during the factor lock wait, removes nothing', async () => {
  const { caller: asked, person } = await caller(false);
  const subject = asked.presented.subject;
  const own = await db.app.withBusiness(business, (tx) =>
    recordFactorEnrolled(tx, {
      personId: person,
      provider: 'supabase',
      providerFactorId: `factor-${randomUUID()}`,
    }),
  );
  const elsewhere = await standingElsewhere(db, subject);
  const theirs = await db.app.withBusiness(elsewhere.business, (tx) =>
    recordFactorEnrolled(tx, {
      personId: elsewhere.person,
      provider: 'supabase',
      providerFactorId: `factor-${randomUUID()}`,
    }),
  );
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
    const acting = ACTS.verify({ ...asked, database: actor }, to);
    await verifying.promise;
    const factorLock = await hold(db.appUrl, elsewhere.business, async (tx) => {
      await advisoryLock(tx, factorLockKey(subject));
      await recordFactorVerified(tx, { personId: elsewhere.person, factorId: theirs.id, subject });
    });
    try {
      verified.release();
      await waitingOn(db.admin, 'advisory', 'pg_advisory_xact_lock');
      expect(
        await signOutSession({ ...asked, businessId: elsewhere.business, database: other }, {}, to),
      ).not.toMatchObject({ refused: true });
    } finally {
      await factorLock.letGo();
    }
    const result = await acting;
    const [mine, yours] = await Promise.all([
      db.app.withBusiness(business, (tx) => liveFactor(tx, person)),
      db.app.withBusiness(elsewhere.business, (tx) => liveFactor(tx, elsewhere.person)),
    ]);
    expect({
      result,
      mine: mine?.id === own.id ? mine.status : 'none',
      yours: yours?.status ?? 'none',
      removed,
    }).toMatchObject({
      result: { refused: true, code: 'AUTH_SESSION_EXPIRED' },
      mine: 'unverified',
      yours: 'verified',
      removed: [],
    });
  } finally {
    verified.release();
    await Promise.all([actor.close(), other.close()]);
  }
});

// A session refused while a reset of its login is open is ended for good
// (`sessionEnded`), so it stays refused however the reset settles. Here the
// refusal comes from the session asked after the enrolment's factor lock
// wait, and the enrolment's own changes are taken back: the ending must stand.
// The provider's sign-in time is 50 seconds ahead of the database (inside the
// skew it serves), so only that ending, not the settle, refuses it afterwards.
it('an enrolment refused for a reset opened during its factor lock wait leaves the session ended after the reset settles', async () => {
  const { caller: base, person } = await caller(false);
  const [clock] = await db.admin.execute<{ readonly ahead: string }>(
    'select (floor(extract(epoch from clock_timestamp())) + 50)::bigint::text as ahead',
  );
  const asked: FactorCaller = {
    ...base,
    presented: {
      ...base.presented,
      assurance: { level: 'aal1', signedInAt: Number(clock?.ahead), factorAt: null },
    },
  };
  const enrolling = gate();
  const enrolled = gate();
  const to: FactorProvider = {
    ...provider([]),
    enrol: async () => {
      enrolling.release();
      await enrolled.promise;
      return {
        ok: true,
        value: {
          factorId: `factor-${randomUUID()}`,
          qrCode: 'local qr',
          secret: 'local secret',
          uri: 'otpauth:',
        },
      };
    },
  };
  const actor = connect(db.appUrl);
  try {
    const acting = ACTS.enrol({ ...asked, database: actor }, to);
    await enrolling.promise;
    const factorLock = await hold(db.appUrl, business, async (tx) => {
      await advisoryLock(tx, factorLockKey(asked.presented.subject));
    });
    let reset = '';
    try {
      enrolled.release();
      await waitingOn(db.admin, 'advisory', 'pg_advisory_xact_lock');
      reset = await db.app.withBusiness(business, (tx) =>
        openResetWindow(tx, asked.presented.subject),
      );
    } finally {
      await factorLock.letGo();
    }
    const result = await acting;
    const [marked] = await db.admin.execute<{ readonly marks: number }>(
      'select count(*)::int as marks from ops.ended_provider_sessions where session_id = $1::uuid',
      [asked.presented.sessionId],
    );
    await db.app.withBusiness(business, (tx) => settleResetWindow(tx, reset));
    const after = await db.app.withBusiness(business, (tx) =>
      resolveLogin(tx, asked.presented, 'enrolling'),
    );
    const live = await db.app.withBusiness(business, (tx) => liveFactor(tx, person));
    expect({ result, marks: marked?.marks, after, factor: live?.status ?? 'none' }).toMatchObject({
      result: { refused: true, code: 'AUTH_SESSION_EXPIRED' },
      marks: 1,
      after: { refused: true, code: 'AUTH_SESSION_EXPIRED' },
      factor: 'none',
    });
  } finally {
    enrolled.release();
    await actor.close();
  }
});
