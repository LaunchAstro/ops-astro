// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-5 isolation: the token ledger on the task read, through the real
// boundary and a fresh Postgres. Two approved tasks, one per client, each
// with its own envelope. The crossings, statuses checked, with no body
// carrying task one's envelope or reservation ids, refusals included: another
// business (the same login in Bravo, answered as a made-up task is); another
// client in the same business (a reader of task two sees task two's ledger and
// nothing of task one's); another person under a live delegation (the agent
// working task two reads nothing of task one's ledger).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { authorised, post, tokenFor, type Answer } from './fixture.ts';
import { checksWorld, pickedUpOn, type PickedUp } from './mp-6-1-checks-fixture.ts';
import type { Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Ledger {
  readonly envelopes: readonly { readonly id: string }[];
}

// eslint-disable-next-line max-lines-per-function -- one world of two businesses, every crossing on it
describe.skipIf(serverUrl === undefined)('MP-6-5 isolation', () => {
  let c: Controls;
  let one: PickedUp;
  let two: PickedUp;
  let readerOfTwo: Member;
  let both: Member;
  let foreign: readonly string[] = [];

  const carriesNothing = (answer: { readonly body: unknown }): void => {
    const text = JSON.stringify(answer.body);
    for (const value of foreign) expect(text).not.toContain(value);
  };
  const ledgerOf = (answer: Answer): Ledger =>
    (answer.body['task'] as { readonly ledger: Ledger }).ledger;

  beforeAll(async () => {
    ({ c } = await checksWorld('mp_6_5_isolation'));
    one = await pickedUpOn(c, 'client_one_work');
    two = await pickedUpOn(c, 'client_two_work');
    const rows = await c.fixture.db.admin.execute<{ readonly id: string }>(
      `select id from public.task_envelopes where task_id = $1
       union all select id from public.reservations r
        where r.envelope_id in (select id from public.task_envelopes where task_id = $1)`,
      [one.taskId],
    );
    foreign = rows.map((row) => row.id);
    const { db, business } = c.fixture;
    readerOfTwo = await enrol(db.app, business, 'reader-two');
    both = await enrol(db.app, business, 'both');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, readerOfTwo, 'read', { kind: 'record', id: two.taskId });
    });
    const bravo = await insertBusiness(db.app, 'bravo');
    await installSpine(db.app, bravo);
    await db.app.withBusiness(bravo, async (tx) => {
      const { insertActor, insertLogin, insertMapping, insertMembership, insertPerson } =
        await import('../identity/fixture.ts');
      const personId = await insertPerson(tx, 'both-bravo');
      const actorId = await insertActor(tx, personId);
      await insertMembership(tx, personId);
      const loginId = await insertLogin(tx, both.presented.subject);
      await insertMapping(tx, loginId, personId, actorId);
      await grantTo(tx, { personId, actorId, presented: both.presented }, 'read');
    });
  }, 180_000);

  afterAll(async () => await c?.drop());

  it('MP-6-5 isolation: the owner reads task one’s ledger', async () => {
    const own = await c.asPerson('task.read', { recordId: one.taskId });
    expect(own.status).toBe(200);
    expect(ledgerOf(own).envelopes.map((envelope) => envelope.id)).toStrictEqual([foreign[0]]);
  });

  it('MP-6-5 isolation: another business reads nothing, answered exactly as a made-up task', async () => {
    const token = authorised(await tokenFor(both.presented.subject));
    const across = await post(c.api, '/api/b/bravo/task/read', { recordId: one.taskId }, token);
    const madeUp = await post(c.api, '/api/b/bravo/task/read', { recordId: randomUUID() }, token);
    expect(across.status).toBe(404);
    expect(across).toEqual(madeUp);
    carriesNothing(across);
  });

  it('MP-6-5 isolation: another client in the same business: a reader of task two sees its ledger and nothing of task one’s', async () => {
    const own = await c.asPerson('task.read', { recordId: two.taskId }, readerOfTwo);
    expect(own.status).toBe(200);
    expect(ledgerOf(own).envelopes).toHaveLength(1);
    carriesNothing(own);
    const across = await c.asPerson('task.read', { recordId: one.taskId }, readerOfTwo);
    expect([403, 404]).toContain(across.status);
    carriesNothing(across);
  });

  it('MP-6-5 isolation: another person under a live delegation: the agent working task two reads nothing of task one’s', async () => {
    const across = await c.asAgent('task.read', { recordId: one.taskId }, two.credential);
    expect([403, 404]).toContain(across.status);
    carriesNothing(across);
  });
});
