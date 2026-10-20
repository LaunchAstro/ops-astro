// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-5 isolation: the token ledger on the task read, through the real
// boundary and a fresh Postgres. Two approved tasks, one per client, each
// with its own envelope. The crossings, statuses checked, with no body
// carrying task one's envelope or reservation ids, refusals included: another
// business (the same login in Bravo, answered as a made-up task is); another
// client in the same business (a reader of task two sees task two's ledger and
// nothing of task one's); another person under a live delegation (the agent
// working task two reads nothing of task one's ledger, and is shown no ledger
// on its own task, since the ledger names the business's cap).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { authorised, post, tokenFor, type Answer } from './fixture.ts';
import { checksWorld, pickedUpOn, type PickedUp } from './mp-6-1-checks-fixture.ts';
import { detailOf, type Controls } from './controls-fixture.ts';

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
  let dee: Member;
  let both: Member;
  let foreign: readonly string[] = [];
  let clientOne = '';
  let clientTwo = '';

  /** A stored client of the business, and `taskId` linked to it on the record's spine. */
  const underNewClient = async (taskId: string, by: Member): Promise<string> => {
    const client = randomUUID();
    await c.fixture.db.admin.execute(
      `insert into public.clients (business_id, id, name, created_by_actor_id)
       values ($1, $2, $3, $4)`,
      [c.fixture.business, client, `mp-6-5 client ${client.slice(0, 8)}`, by.actorId],
    );
    await c.fixture.db.admin.execute(
      `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
      [taskId, client],
    );
    return client;
  };
  /** Task work proposed by the owner, approved by `approver`, and picked up by the agent. */
  const approvedBy = async (approver: Member, purpose: string): Promise<PickedUp> => {
    const task = await c.createTask(`a task for ${purpose}`);
    const proposal = await c.propose(task.id, task.revision, purpose);
    const decided = await c.asPerson(
      'task.decide',
      {
        gateId: proposal['gateId'],
        versionId: proposal['versionId'],
        decision: 'approve',
        note: 'approved so an agent can work it',
      },
      approver,
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const reservationId = String(detailOf(decided)['reservationId']);
    const picked = await c.pickup(reservationId, 600);
    return {
      taskId: task.id,
      lineageId: String(proposal['lineageId']),
      versionId: String(proposal['versionId']),
      leaseId: String(picked['leaseId']),
      fence: Number(picked['fence']),
      credential: String(picked['credential']),
    };
  };
  const clientOf = async (taskId: string): Promise<string | null> =>
    (
      await c.fixture.db.admin.execute<{ readonly client: string | null }>(
        'select uuid_7::text as client from public.records where id = $1',
        [taskId],
      )
    )[0]?.client ?? null;

  const carriesNothing = (answer: { readonly body: unknown }): void => {
    const text = JSON.stringify(answer.body);
    for (const value of foreign) expect(text).not.toContain(value);
  };
  const ledgerOf = (answer: Answer): Ledger =>
    (answer.body['task'] as { readonly ledger: Ledger }).ledger;

  beforeAll(async () => {
    ({ c } = await checksWorld('mp_6_5_isolation'));
    // Task one's run is another person's: Dee approves it, so the agent works it
    // under Dee's delegation, and task two's under the owner's.
    dee = await enrol(c.fixture.db.app, c.fixture.business, 'dee');
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      for (const collection of ['task', 'gate', 'billing'] as const) {
        for (const action of ['read', 'write', 'decide', 'comment'] as const) {
          // eslint-disable-next-line no-await-in-loop -- one grant at a time
          await grantTo(tx, dee, action, WHOLE_BUSINESS, false, collection);
        }
      }
    });
    one = await approvedBy(dee, 'client_one_work');
    two = await pickedUpOn(c, 'client_two_work');
    const rows = await c.fixture.db.admin.execute<{ readonly id: string }>(
      `select id from public.task_envelopes where task_id = $1
       union all select id from public.reservations r
        where r.envelope_id in (select id from public.task_envelopes where task_id = $1)
       union all select run_id from public.reservations r
        where r.envelope_id in (select id from public.task_envelopes where task_id = $1)`,
      [one.taskId],
    );
    foreign = rows.map((row) => row.id);
    const { db, business } = c.fixture;
    readerOfTwo = await enrol(db.app, business, 'reader-two');
    both = await enrol(db.app, business, 'both');
    // One stored client per task, so the client crossing crosses two real
    // clients: the reader of task two holds a grant on client two's task alone.
    [clientOne, clientTwo] = [
      await underNewClient(one.taskId, readerOfTwo),
      await underNewClient(two.taskId, readerOfTwo),
    ];
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
    // A real crossing: each task on its own stored client.
    expect(await clientOf(one.taskId)).toBe(clientOne);
    expect(await clientOf(two.taskId)).toBe(clientTwo);
    expect(clientOne).not.toBe(clientTwo);
    const own = await c.asPerson('task.read', { recordId: two.taskId }, readerOfTwo);
    expect(own.status).toBe(200);
    expect(ledgerOf(own).envelopes).toHaveLength(1);
    carriesNothing(own);
    const across = await c.asPerson('task.read', { recordId: one.taskId }, readerOfTwo);
    expect([403, 404]).toContain(across.status);
    carriesNothing(across);
  });

  it('MP-6-5 isolation: the agent working a task is shown no ledger: it names the business’s cap', async () => {
    const own = await c.asAgent('task.read', { recordId: two.taskId }, two.credential);
    expect(own.status).toBe(200);
    // An agent's answer carries the task under `detail`.
    const task = (own.body['detail'] as { readonly task: { readonly ledger: Ledger | null } }).task;
    expect(task).toBeDefined();
    expect(task.ledger).toBeNull();
    const cap = await c.fixture.db.admin.execute<{ readonly key: string; readonly limit: string }>(
      `select cap.key, cap.limit_minor::text as limit from public.task_envelopes e
         join public.budget_caps cap on cap.business_id = e.business_id and cap.id = e.cap_id
        where e.task_id = $1`,
      [two.taskId],
    );
    expect(JSON.stringify(own.body)).not.toContain(`"${cap[0]?.key ?? 'missing'}"`);
  });

  it('MP-6-5 isolation: another person under a live delegation: the agent working task two reads nothing of task one’s', async () => {
    // A real crossing: each task's live delegation is from a different person.
    const delegators = await c.fixture.db.admin.execute<{ readonly person: string }>(
      `select d.delegate_person_id::text as person from public.delegations d
        where d.purpose_scope_id = any($1::uuid[]) and d.revoked_at is null
        order by array_position($1::uuid[], d.purpose_scope_id)`,
      [[one.taskId, two.taskId]],
    );
    expect(delegators.map((row) => row.person)).toStrictEqual([dee.personId, c.manager.personId]);
    const across = await c.asAgent('task.read', { recordId: one.taskId }, two.credential);
    expect([403, 404]).toContain(across.status);
    carriesNothing(across);
  });
});
