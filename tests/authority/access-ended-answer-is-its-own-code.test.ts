// SPDX-License-Identifier: AGPL-3.0-only
//
// C58: the API's answer to a person whose access here was ended is its own
// code, `AUTH_ACCESS_ENDED` 403, so a client that has never seen this bearer
// before (a reload, a new tab) can still tell an ended person from a login that
// was never a member. A login with no ending here, in this business or any
// other, still gets `AUTH_NO_MEMBERSHIP`, which says nothing more.

import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import {
  apiWith,
  end,
  harness,
  outcome,
  ownCall,
  scripted,
  teammate,
  useEndAccessWorld,
} from './c58-end-access-world.ts';

useEndAccessWorld();

async function namesEndingInEndingBusiness() {
  const api = apiWith(scripted().provider);
  const { person, token } = await teammate('ended-here');
  const subject = person.presented.subject;
  await harness.world.db.app.withBusiness(harness.world.bravo, async (tx) => {
    const personId = await insertPerson(tx, 'still-in-bravo');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    await grantTo(
      tx,
      { personId, actorId, presented: { provider: 'supabase', subject } },
      'read',
      WHOLE_BUSINESS,
    );
  });

  expect(outcome(await end(api, person.personId))).toEqual({ status: 200, code: 'ok' });

  expect(outcome(await ownCall(api, token))).toEqual({ status: 403, code: 'AUTH_ACCESS_ENDED' });
  expect(outcome(await ownCall(api, token, 'bravo'))).toEqual({ status: 200, code: 'ok' });
}

describe.skipIf(serverUrl === undefined)('the answer to a person whose access ended', () => {
  it(
    'names the ending in the business that ended it, and the other business still serves them',
    namesEndingInEndingBusiness,
  );

  it('is not given to a login another business ended, nor to a member removed without an ending', async () => {
    const api = apiWith(scripted().provider);
    // Bravo's teammate with no login in alpha: alpha has nothing to say about them.
    const { token: bravoOnly } = await teammate('bravo-only', harness.world.bravo);
    expect(outcome(await ownCall(api, bravoOnly))).toEqual({
      status: 403,
      code: 'AUTH_NO_MEMBERSHIP',
    });

    // Alpha's ending is alpha's: a bravo login of the same subject is not told of it.
    const { person: ended, token: endedToken } = await teammate('ended-in-alpha');
    expect(outcome(await end(api, ended.personId))).toEqual({ status: 200, code: 'ok' });
    expect(outcome(await ownCall(api, endedToken, 'bravo'))).toEqual({
      status: 403,
      code: 'AUTH_NO_MEMBERSHIP',
    });

    // An alpha login whose membership lapsed with no access ending written is a denial.
    const { person: lapsed, token: lapsedToken } = await teammate('lapsed');
    await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
      await tx.query(
        `update public.memberships set active = false, ended_at = now()
          where business_id = $1 and person_id = $2`,
        [harness.world.alpha, lapsed.personId],
      );
    });
    expect(outcome(await ownCall(api, lapsedToken))).toEqual({
      status: 403,
      code: 'AUTH_NO_MEMBERSHIP',
    });
  });
});
