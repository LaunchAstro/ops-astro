// SPDX-License-Identifier: AGPL-3.0-only
//
// A factor row belongs to one login, so every read and change of one names the
// login that holds it. A factor reset is the owner's act on a member's factor:
// it finds, locks and removes the factor by the member's own login, the one
// sign-in login the reset resolves for them, never by the owner's, who signed
// in to send it. Both hold a verified factor here; the reset ends the member's,
// here and in the login record, and owes the provider that factor's removal;
// the owner's stays verified.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  liveFactor,
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from './fixture.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;

let db: FreshDatabase;
let business: string;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  db = await createFreshDatabase({ part: 'factorresetlogin' });
  business = await insertBusiness(db.app, 'factor-reset-login');
  await installSpine(db.app, business);
}, 180_000);
afterAll(async () => {
  await db?.drop();
});

/** A verified factor of `member`'s own login: its provider id. */
async function verifiedFactor(member: Member): Promise<string> {
  const providerFactorId = `factor-${randomUUID()}`;
  const { personId, presented } = member;
  await db.app.withBusiness(business, async (tx) => {
    const { subject } = presented;
    const factor = await recordFactorEnrolled(tx, {
      personId,
      subject,
      provider: 'supabase',
      providerFactorId,
    });
    await recordFactorVerified(tx, { personId, factorId: factor.id, subject });
  });
  return providerFactorId;
}

/** `member`'s live factor held by their own login, as provider id and status. */
const heldBy = async (member: Member) => {
  const live = await db.app.withBusiness(business, (tx) =>
    liveFactor(tx, member.personId, member.presented.subject),
  );
  return live === undefined ? 'none' : `${live.providerFactorId} ${live.status}`;
};

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

it("a factor reset removes the member's factor by the member's own login and leaves the owner's", async () => {
  const owner = await enrol(db.app, business, 'Owner');
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, owner, 'manage', WHOLE_BUSINESS, false, 'settings');
  });
  const ownerFactor = await verifiedFactor(owner);
  const member = await enrol(db.app, business, 'Member');
  const memberFactor = await verifiedFactor(member);
  const body = {
    command: 'access.reset_factor',
    operationId: randomUUID(),
    holderId: member.personId,
  };
  const answer = await executeCommand(db.app, business, owner.presented, 'api', body as never);
  const [owed] = await db.admin.execute<{ readonly factor: string }>(
    `select provider_factor_id as factor from public.factor_resets
      where business_id = $1 and person_id = $2`,
    [business, member.personId],
  );
  const removed = await db.admin.execute<{ readonly factor: string }>(
    `select factor_digest as factor from ops.second_factor_subjects
      where subject_digest = $1 and state = 'removed'`,
    [digest(member.presented.subject)],
  );
  expect({
    applied: !isCommandRefusal(answer),
    member: await heldBy(member),
    owner: await heldBy(owner),
    owed: owed?.factor,
    removed,
  }).toEqual({
    applied: true,
    member: 'none',
    owner: `${ownerFactor} verified`,
    owed: memberFactor,
    removed: [{ factor: digest(memberFactor) }],
  });
});
