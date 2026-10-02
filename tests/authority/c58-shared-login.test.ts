// SPDX-License-Identifier: AGPL-3.0-only
//
// C58 and a login shared across businesses (ORCH46 ruling A). A GoTrue user is
// one person's across every business, while a login row is one business's
// (0002_identity.sql:132). Ending access in alpha must not ban the provider
// user while that subject is still live in bravo: the provider steps are then
// stamped done with the reason `shared`, and nothing is sent. The API's own
// ending always stands. Once no other business holds it live, the ban goes.
//
// The first case is the Opus interim reviewer's proof, applied unchanged.

import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import {
  apiWith,
  end,
  harness,
  outcome,
  ownCall,
  scripted,
  signedIn,
  nowSeconds,
  teammate,
  useEndAccessWorld,
} from '../authority/c58-end-access-world.ts';
import { grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';

useEndAccessWorld();

describe.skipIf(serverUrl === undefined)('C58 interim review: the ban and other businesses', () => {
  it('C58 isolation: ending access in alpha never bans a provider login still live in bravo', async () => {
    const { calls, provider } = scripted();
    const api = apiWith(provider);
    const { person } = await teammate('dual');
    const subject = person.presented.subject;
    // The same provider user is also bravo's teammate, live there.
    await harness.world.db.app.withBusiness(harness.world.bravo, async (tx) => {
      const personId = await insertPerson(tx, 'dual-in-bravo');
      const actorId = await insertActor(tx, personId);
      await insertMembership(tx, personId);
      await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
      const member: Member = { personId, actorId, presented: { provider: 'supabase', subject } };
      await grantTo(tx, member, 'read', WHOLE_BUSINESS);
    });
    const token = await signedIn(subject, nowSeconds() - 60);
    expect(outcome(await ownCall(api, token, 'bravo'))).toEqual({ status: 200, code: 'ok' });

    expect(outcome(await end(api, person.personId))).toEqual({ status: 200, code: 'ok' });

    // Still bravo's: its API answers them, so the provider must still let them in.
    expect(outcome(await ownCall(api, token, 'bravo'))).toEqual({ status: 200, code: 'ok' });
    expect(calls.filter((c) => c.subject === subject)).toEqual([]);
  });
});

/** The subject made bravo's live teammate too; answers bravo's person. */
async function liveInBravo(subject: string): Promise<Member> {
  return await harness.world.db.app.withBusiness(harness.world.bravo, async (tx) => {
    const personId = await insertPerson(tx, 'shared-in-bravo');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    const member: Member = { personId, actorId, presented: { provider: 'supabase', subject } };
    await grantTo(tx, member, 'read', WHOLE_BUSINESS);
    return member;
  });
}

const reasonOf = async (personId: string): Promise<readonly unknown[]> =>
  await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) =>
    (
      await tx.query<{ readonly skipped: string | null }>(
        `select provider_steps_skipped as skipped from public.access_endings
          where person_id = $1`,
        [personId],
      )
    ).map((row) => row.skipped),
  );

describe.skipIf(serverUrl === undefined)('C58 a login shared with another business', () => {
  it("C58 isolation: a skipped ban is stamped done with the reason 'shared', and the ending still refuses alpha", async () => {
    const { calls, provider } = scripted();
    const api = apiWith(provider);
    const { person, token } = await teammate('shared');
    await liveInBravo(person.presented.subject);
    expect(outcome(await end(api, person.personId))).toEqual({ status: 200, code: 'ok' });
    expect(calls).toEqual([]);
    expect(await reasonOf(person.personId)).toEqual(['shared']);
    expect(outcome(await ownCall(api, token))).toEqual({ status: 403, code: 'AUTH_NO_MEMBERSHIP' });
  });

  it('C58 isolation: once no other business holds the login live, ending it bans at the provider', async () => {
    const { calls, provider } = scripted();
    const api = apiWith(provider);
    const { person } = await teammate('once');
    const subject = person.presented.subject;
    const bravo = await liveInBravo(subject);
    // Bravo ends its side first: its own ending, and the ban is skipped (alpha is live).
    expect(outcome(await end(api, bravo.personId, harness.world.bea.token, 'bravo'))).toEqual({
      status: 200,
      code: 'ok',
    });
    expect(calls).toEqual([]);
    // Now alpha's ending is the last: the ban goes.
    expect(outcome(await end(api, person.personId))).toEqual({ status: 200, code: 'ok' });
    expect(calls).toEqual([
      { step: 'endSessions', subject },
      { step: 'deactivate', subject },
    ]);
    expect(await reasonOf(person.personId)).toEqual([null]);
  });
});
