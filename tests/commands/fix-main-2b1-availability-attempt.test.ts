// SPDX-License-Identifier: AGPL-3.0-only
//
// FIX-MAIN-2B1 P2-F2 (I13): every sign-in attempt is recorded exactly once in
// authentication_attempts. `availability.set` is a signed-in write, so one
// call leaves one attempt row, applied or refused, as `preference.save` does.
// It resolved its caller through `withStanding`, the live channel's recheck
// that records nothing, so the call left no row at all.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setOwnAvailability } from '../../packages/core-commands/src/index.ts';
import { subjectDigest } from '../../packages/core-records/src/identity/authentication-attempts.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/verified-subject.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, freshSubject } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('FIX-MAIN-2B1 P2-F2: DATABASE_URL is unset, so nothing below ran.');
}

let db: FreshDatabase;
let business: string;

/** Every attempt row for this presented subject, by outcome and code. */
async function attempts(presented: VerifiedSubject) {
  return await db.admin.execute<{
    readonly outcome: string;
    readonly refusal_code: string | null;
  }>(
    `select outcome, refusal_code from public.authentication_attempts
      where business_id = $1 and subject_digest = $2`,
    [business, subjectDigest(presented)],
  );
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'fm2b1avail' });
  business = await insertBusiness(db.app, 'alpha');
}, 60_000);

afterAll(async () => await db?.drop());

describe.skipIf(serverUrl === undefined)('FIX-MAIN-2B1 P2-F2 availability.set attempt', () => {
  it('P2-F2: one applied availability.set records exactly one resolved attempt', async () => {
    const me = await enrol(db.app, business, `avail-${randomUUID().slice(0, 8)}`);

    const set = await setOwnAvailability(db.app, business, me.presented, {
      state: 'away',
      reason: 'Lunch',
    });
    expect(set).toEqual({ availability: { state: 'away', reason: 'Lunch' } });

    expect(await attempts(me.presented)).toEqual([{ outcome: 'resolved', refusal_code: null }]);
  });

  it('P2-F2: one availability.set refused for its body records exactly one resolved attempt', async () => {
    const me = await enrol(db.app, business, `avail-${randomUUID().slice(0, 8)}`);

    const set = await setOwnAvailability(db.app, business, me.presented, { state: 'asleep' });
    expect(set).toMatchObject({ refused: true, code: 'FIELD_VALUE_INVALID' });

    expect(await attempts(me.presented)).toEqual([{ outcome: 'resolved', refusal_code: null }]);
  });

  it('P2-F2: one availability.set by a login with no standing records exactly one refused attempt', async () => {
    const stranger = freshSubject(`stranger-${randomUUID()}`);

    const set = await setOwnAvailability(db.app, business, stranger, { state: 'away' });
    expect(set).toMatchObject({ refused: true });

    expect(await attempts(stranger)).toEqual([
      { outcome: 'refused', refusal_code: 'AUTH_NO_MEMBERSHIP' },
    ]);
  });
});
