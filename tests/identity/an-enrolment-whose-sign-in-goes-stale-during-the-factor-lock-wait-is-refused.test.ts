// SPDX-License-Identifier: AGPL-3.0-only
//
// A first enrolment needs a password sign-in inside the step-up window. The
// check before the provider call is not the last word: the record step waits
// for the login's factor lock, and a sign-in can leave the window during that
// wait. The record step judges it again after the wait, on the clock as it is
// then, not the clock its transaction started at. A fixture holds the factor
// lock; the enrolment, signed in just inside the window, passes its check,
// reaches the provider, and parks on the lock; the fixture lets go only once
// the sign-in is past the window. The enrolment is refused
// `FRESH_SIGN_IN_REQUIRED`, records no factor, and the factor the provider
// issued is let go there.

import { setTimeout as pause } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { enrolSecondFactor } from '../../packages/core-commands/src/commands/account-factor.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import { STEP_UP_WINDOW_SECONDS } from '../../packages/core-records/src/authority/step-up.ts';
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
import { insertBusiness } from './fixture.ts';
import { factorCaller, factorLockKey, provider } from './factor-lock-wait-fixture.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;

let db: FreshDatabase;
let business: BusinessId;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  db = await createFreshDatabase({ part: 'factorstalesignin' });
  business = (await insertBusiness(db.app, 'factor-stale-sign-in')) as BusinessId;
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

/** Seconds of the window left at the check before the provider call. */
const MARGIN = 3;

it('an enrolment whose sign-in leaves the window while it waits for the factor lock is refused and records nothing', async () => {
  const { caller, person } = await factorCaller(db, business, false);
  const signedInAt = Math.floor(Date.now() / 1000) - STEP_UP_WINDOW_SECONDS + MARGIN;
  const asked = {
    ...caller,
    presented: { ...caller.presented, assurance: { level: 'aal1', signedInAt, factorAt: null } },
  } as const;
  const issued: string[] = [];
  const removed: string[] = [];
  const answering = provider(removed);
  const to: FactorProvider = {
    ...answering,
    enrol: async (token) => {
      const answer = await answering.enrol(token);
      if (answer.ok) issued.push(answer.value.factorId);
      return answer;
    },
  };
  const actor = connect(db.appUrl);
  const factorLock = await hold(db.appUrl, business, async (tx) => {
    await advisoryLock(tx, factorLockKey(caller.presented.subject));
  });
  let result: unknown;
  try {
    let enrolling: Promise<unknown> | undefined;
    try {
      enrolling = enrolSecondFactor({ ...asked, database: actor }, to);
      await waitingOn(db.admin, 'advisory', 'pg_advisory_xact_lock');
      // Past the window by more than the clock's whole-second rounding.
      await pause((signedInAt + STEP_UP_WINDOW_SECONDS + 2) * 1000 - Date.now());
    } finally {
      await factorLock.letGo();
    }
    result = await enrolling;
  } finally {
    await actor.close();
  }
  const rows = await db.admin.execute<{ readonly status: string }>(
    'select status from public.second_factors where business_id = $1 and person_id = $2',
    [business, person],
  );
  expect({ result, issued: issued.length, rows, removed }).toEqual({
    result: expect.objectContaining({ refused: true, code: 'FRESH_SIGN_IN_REQUIRED' }),
    issued: 1,
    rows: [],
    removed: issued,
  });
});

it('an enrolment signed in a moment ago, judged again after the factor lock, is recorded', async () => {
  const { caller, person } = await factorCaller(db, business, false);
  const answer = await enrolSecondFactor(caller, provider([]));
  const rows = await db.admin.execute<{ readonly status: string }>(
    'select status from public.second_factors where business_id = $1 and person_id = $2',
    [business, person],
  );
  expect({ issued: 'factorId' in answer, rows }).toEqual({
    issued: true,
    rows: [{ status: 'unverified' }],
  });
});
