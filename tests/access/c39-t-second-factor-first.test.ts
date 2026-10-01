// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, the gate before the first real client data (item 2): after
// enrolment, the person's first sign-in sets up C59's second factor before
// any content shows. A login bound to a person an accepted invitation names,
// with no verified factor, is refused every read (a task board, the client
// list, the conversation list) with `AUTH_SECOND_FACTOR_SETUP_REQUIRED`;
// the factor routes still serve it, so it can enrol and verify; once the
// factor is verified the reads are served on a sign-in that used it. A login
// no invitation placed, with no factor, is admitted as before, and another
// business's accepted invitation never counts here.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  enrolSecondFactor,
  executeRead,
  verifySecondFactor,
  type FactorCaller,
  type FactorProvider,
} from '../../packages/core-commands/src/index.ts';
import type { AssuranceLevel } from '../../packages/core-records/src/identity/verified-subject.ts';
import type { ReadRequest } from '../../packages/core-commands/src/index.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { e, enrolVia, heldInBravo, invited, useEnrolWorld } from './c39-t-enrol-world.ts';
import { addressFor, c, noDatabase, w } from './c39-t-world.ts';

useEnrolWorld();

const GATE = 'AUTH_SECOND_FACTOR_SETUP_REQUIRED';

const CONTENT: readonly ReadRequest[] = [
  { read: 'task.board', board: null },
  { read: 'client.list' },
  { read: 'conversation.list' },
] as ReadRequest[];

const presentedAs = (subject: string, level: AssuranceLevel) => {
  const now = Math.floor(Date.now() / 1000);
  return {
    provider: 'supabase',
    subject,
    assurance: { level, signedInAt: now, factorAt: level === 'aal2' ? now : null },
  };
};

/** Each content read's refusal code, or `served`. */
async function reads(business: string, subject: string, level: AssuranceLevel) {
  const answers: string[] = [];
  for (const request of CONTENT) {
    // oxlint-disable-next-line no-await-in-loop -- one read after the other
    const answer = await executeRead(w.db.app, business, presentedAs(subject, level), request);
    answers.push('refused' in answer ? answer.code : 'served');
  }
  return answers;
}

/** A stand-in provider that issues a factor and accepts its first code. */
function standIn(): FactorProvider {
  const done = Promise.resolve({ ok: true, value: undefined } as const);
  const issued = { factorId: `factor-${randomUUID()}`, qrCode: 'qr', secret: 's', uri: 'otpauth:' };
  const session = { accessToken: 'aal2-access-token', refreshToken: 'refresh', expiresIn: 3600 };
  return {
    enrol: () => Promise.resolve({ ok: true, value: issued } as const),
    verify: () => Promise.resolve({ ok: true, value: session } as const),
    remove: () => done,
    signOut: () => done,
  };
}

const callerOf = (business: string, subject: string): FactorCaller => ({
  database: w.db.app,
  businessId: business,
  presented: presentedAs(subject, 'aal1'),
  accessToken: 'aal1-access-token',
});

/** The grants the three reads ask: tasks read, conversations written (their list's key). */
async function grantReads(business: string, subject: string): Promise<void> {
  await w.db.app.withBusiness(business, async (tx) => {
    const [row] = await tx.query<{ person_id: string; actor_id: string }>(
      `select pl.person_id, a.id as actor_id from logins l
         join person_logins pl on pl.business_id = l.business_id and pl.login_id = l.id
         join actors a on a.business_id = pl.business_id and a.person_id = pl.person_id
        where l.subject = $1 and a.kind = 'person'`,
      [subject],
    );
    const member = {
      personId: String(row?.person_id),
      actorId: String(row?.actor_id),
      presented: presentedAs(subject, 'aal2'),
    };
    await grantTo(tx, member, 'read');
    await grantTo(tx, member, 'write', WHOLE_BUSINESS, false, 'conversation');
  });
}

/** A login no invitation placed: a person mapped by hand, a member, in `business`. */
async function mappedByHand(business: string, subject: string): Promise<void> {
  await w.db.app.withBusiness(business, async (tx) => {
    const personId = await insertPerson(tx, 'Mapped by hand');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
  });
  await grantReads(business, subject);
}

const NONE = CONTENT.map(() => GATE);
const ALL = CONTENT.map(() => 'served');

describe.skipIf(noDatabase)('C39-T second factor first', () => {
  it('C39-T second factor first: an invitee who accepted gets no content read until a factor is verified, then does', async () => {
    e.users.mode('accept');
    const address = addressFor('second-factor-first');
    const invitation = await invited(c.admin, address);
    expect((await enrolVia(invitation.token)).body).toStrictEqual({ state: 'enrolled' });
    const subject = String(e.users.users.get(address));
    await grantReads(w.alpha, subject);

    expect(await reads(w.alpha, subject, 'aal1')).toStrictEqual(NONE);

    // The factor routes serve the gated login: it sets the factor up.
    const provider = standIn();
    expect(await enrolSecondFactor(callerOf(w.alpha, subject), provider)).not.toHaveProperty(
      'code',
    );
    expect(await reads(w.alpha, subject, 'aal1')).toStrictEqual(NONE);
    const verified = await verifySecondFactor(
      callerOf(w.alpha, subject),
      { code: '123456' },
      provider,
    );
    expect(verified).not.toHaveProperty('code');

    // Verified: a sign-in without it is asked for the code, one with it is served.
    expect(await reads(w.alpha, subject, 'aal1')).toStrictEqual(
      CONTENT.map(() => 'AUTH_SECOND_FACTOR_REQUIRED'),
    );
    expect(await reads(w.alpha, subject, 'aal2')).toStrictEqual(ALL);
  });

  it('C39-T second factor first: a login no invitation placed, with no factor, is admitted as before, and another business’s invitation never counts', async () => {
    // No invitation, no factor: served, as before the gate.
    const byHand = `sub-${randomUUID()}`;
    await mappedByHand(w.alpha, byHand);
    expect(await reads(w.alpha, byHand, 'aal1')).toStrictEqual(ALL);

    // Invited and enrolled in bravo, the same login mapped by hand in alpha:
    // gated in bravo, served in alpha.
    const subject = await heldInBravo(addressFor('invited-in-bravo'));
    await grantReads(w.bravo, subject);
    await mappedByHand(w.alpha, subject);
    expect(await reads(w.bravo, subject, 'aal1')).toStrictEqual(NONE);
    expect(await reads(w.alpha, subject, 'aal1')).toStrictEqual(ALL);
  });
});
