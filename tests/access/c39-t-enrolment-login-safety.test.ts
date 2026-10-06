// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: what the login an accept makes or adopts can and cannot
// carry. Adopting a login an earlier accept stranded ends every session that
// login had, so whoever signed in to it before can never act as the person
// the new invitation admits; that person signs in afresh. An honest provider
// answer is read for the user's id and nothing else, so a password that
// happens to spell one of its ordinary fields still enrols. And the secrecy
// scan the enrolment cases rely on reads every identity row an accept writes.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { standingOf } from '../../packages/core-records/src/identity/index.ts';
import {
  e,
  enrolVia,
  invited,
  lapseClaims,
  passwordFor,
  useEnrolWorld,
} from './c39-t-enrol-world.ts';
import { addressFor, as, c, codeOf, noDatabase, storedText, w } from './c39-t-world.ts';

useEnrolWorld();

const ENROLLED = { status: 200, body: { state: 'enrolled' }, cookie: null };

/** The database's clock, in whole seconds. */
async function dbSeconds(): Promise<number> {
  const [row] = await w.db.admin.execute<{ s: string }>(
    'select floor(extract(epoch from clock_timestamp()))::text as s',
  );
  return Number(row?.s);
}

/** Who a provider session of `subject`, signed in at `signedInAt`, stands as in alpha. */
async function standingAt(subject: string, signedInAt: number): Promise<string> {
  const presented = {
    provider: 'supabase',
    subject,
    sessionId: randomUUID(),
    assurance: { level: 'aal1', signedInAt, factorAt: null },
  } as const;
  const standing = await w.db.app.withBusiness(
    w.alpha,
    async (tx) => await standingOf(tx, presented, 'required'),
  );
  return 'refused' in standing ? standing.code : standing.personId;
}

/** The invitation's person, as the database holds it. */
async function personOf(invitationId: string): Promise<string> {
  const [row] = await w.db.admin.execute<{ person_id: string }>(
    'select person_id from public.invitations where id = $1',
    [invitationId],
  );
  return String(row?.person_id);
}

describe.skipIf(noDatabase)('C39-T enrolment login safety', () => {
  it('C39-T enrolment: adopting a stranded login ends the sessions it had, so an earlier sign-in never stands as the newly admitted person', async () => {
    const address = addressFor('stranded-session');
    const stranded = await invited(c.admin, address);
    e.users.mode('made_late');
    expect((await enrolVia(stranded.token)).status).toBe(503);
    await lapseClaims();
    e.users.mode('accept');
    const made = String(e.users.users.get(address));
    // Someone signed in to the stranded login before it was adopted.
    const earlier = (await dbSeconds()) - 5;
    expect(codeOf(await as(c.admin, 'invitation.revoke', { invitationId: stranded.id }))).toBe(
      'applied',
    );
    const fresh = await invited(c.admin, address);
    expect(await enrolVia(fresh.token, passwordFor())).toStrictEqual(ENROLLED);
    expect(await standingAt(made, earlier)).toBe('AUTH_SESSION_EXPIRED');
    // The person the fresh invitation admits signs in afresh, and stands as themselves.
    expect(await standingAt(made, (await dbSeconds()) + 1)).toBe(await personOf(fresh.id));
  }, 30_000);

  it('C39-T enrolment: a password that spells an ordinary field of the honest answer still enrols', async () => {
    e.users.mode('accept');
    const address = addressFor('ordinary-field');
    const { token } = await invited(c.admin, address);
    expect(await enrolVia(token, 'authenticated')).toStrictEqual(ENROLLED);
    expect(e.users.passwords.get(String(e.users.users.get(address)))).toBe('authenticated');
  }, 30_000);

  it('C39-T enrolment: the secrecy scan reads the identity rows an accept writes', async () => {
    e.users.mode('accept');
    const { id, token } = await invited(c.admin, addressFor('scanned'));
    expect(await enrolVia(token)).toStrictEqual(ENROLLED);
    const planted = passwordFor();
    await w.db.admin.execute(
      'update public.person_identifiers set observed_value = $1 where person_id = $2',
      [planted, await personOf(id)],
    );
    expect((await storedText()).includes(planted)).toBe(true);
  }, 30_000);
});
