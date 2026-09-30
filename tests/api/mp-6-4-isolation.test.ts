// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-4 isolation, through the real boundary and a fresh Postgres.
//
// What MP-6-4 adds that could carry one party's run to another: the scope on
// `task.read`, which names a delegation and the delegating person's grants it
// draws on. The person who authorised both runs here holds a grant on each
// client's task as well as their business-wide ones, so a scope that listed
// the person's grants without the task's own filter would name the other
// client's grant and record. Each crossing asks from the other side and checks
// the status, and that no body carries the canary in A's title, A's task id,
// A's lease, A's delegation or the grant on A's record, refusals included.
//
// The crossings: another business (the same login in Bravo); another client in
// the same business (two people, each reading one task alone); and another
// person's work under a live delegation (the agent working task B under its
// pickup's delegation reaching task A).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { authorised, post, tokenFor, type Answer } from './fixture.ts';
import { detailOf, type Controls } from './controls-fixture.ts';
import { checksWorld, pickedUpOn, type PickedUp } from './mp-6-1-checks-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Scoped {
  readonly delegation: { readonly id: string; readonly grants: readonly { id: string }[] } | null;
}

// eslint-disable-next-line max-lines-per-function -- one world of two businesses, every crossing on it
describe.skipIf(serverUrl === undefined)('MP-6-4 isolation', () => {
  let c: Controls;
  const canary = `CANARY-${randomUUID()}`;
  let workA: PickedUp;
  let workB: PickedUp;
  let grantOnA = '';
  let grantOnB = '';
  let delegationA = '';
  let clientOne: Member;
  let clientTwo: Member;
  let both: Member;

  /** Each client reads its own task alone; the delegating person holds a grant on each task too. */
  async function enrolClients(): Promise<void> {
    const { db, business } = c.fixture;
    clientOne = await enrol(db.app, business, 'client-one');
    clientTwo = await enrol(db.app, business, 'client-two');
    both = await enrol(db.app, business, 'both');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, clientOne, 'read', { kind: 'record', id: workA.taskId });
      await grantTo(tx, clientTwo, 'read', { kind: 'record', id: workB.taskId });
      grantOnA = await grantTo(tx, c.manager, 'comment', { kind: 'record', id: workA.taskId });
      grantOnB = await grantTo(tx, c.manager, 'comment', { kind: 'record', id: workB.taskId });
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
  }

  beforeAll(async () => {
    ({ c } = await checksWorld('mp_6_4_isolation'));
    workA = await pickedUpOn(c, 'scope_client_one');
    workB = await pickedUpOn(c, 'scope_client_two');
    const readA = await c.asPerson('task.read', { recordId: workA.taskId });
    const titled = await c.asPerson('task.update', {
      recordId: workA.taskId,
      expectedRevision: (readA.body['task'] as { revision: number }).revision,
      fields: { title: `${canary} client one` },
    });
    expect(titled.status).toBe(200);
    await enrolClients();
    const rows = await c.fixture.db.admin.execute<{ readonly delegation_id: string }>(
      `select delegation_id from public.leases where id = $1`,
      [workA.leaseId],
    );
    delegationA = rows[0]?.delegation_id ?? '';
  }, 180_000);

  afterAll(async () => await c?.drop());

  const carriesNothingOfA = (answer: Answer): void => {
    const text = JSON.stringify(answer.body);
    for (const foreign of [canary, workA.taskId, workA.leaseId, delegationA, grantOnA]) {
      expect(foreign).not.toBe('');
      expect(text).not.toContain(foreign);
    }
  };

  /** The first lineage's scopes; an agent's answer carries the task under `detail`. */
  const scopesIn = (answer: Answer): readonly Scoped[] => {
    const task = (answer.body['task'] ?? detailOf(answer)['task']) as {
      readonly proposals: readonly { readonly scopes: readonly Scoped[] }[];
    };
    return task.proposals[0]?.scopes ?? [];
  };

  it('another business: the same login in Bravo reads nothing of A', async () => {
    const bravoRead = await post(
      c.api,
      '/api/b/bravo/task/read',
      { operationId: randomUUID(), recordId: workA.taskId },
      authorised(await tokenFor(both.presented.subject)),
    );
    expect(bravoRead.status).toBe(404);
    carriesNothingOfA(bravoRead);
  });

  it('another client in the same business: each scope names its own task’s grant only', async () => {
    const one = await c.asPerson('task.read', { recordId: workA.taskId }, clientOne);
    expect(one.status).toBe(200);
    const onA = scopesIn(one)[0]?.delegation?.grants.map((grant) => grant.id) ?? [];
    expect(onA).toContain(grantOnA);
    expect(onA).not.toContain(grantOnB);
    expect(JSON.stringify(one.body)).not.toContain(workB.taskId);

    const two = await c.asPerson('task.read', { recordId: workB.taskId }, clientTwo);
    expect(two.status).toBe(200);
    const onB = scopesIn(two)[0]?.delegation?.grants.map((grant) => grant.id) ?? [];
    expect(onB).toContain(grantOnB);
    carriesNothingOfA(two);

    const across = await c.asPerson('task.read', { recordId: workA.taskId }, clientTwo);
    expect(across.status).toBe(403);
    carriesNothingOfA(across);
  });

  it('another person’s work under a live delegation: B’s agent reaches nothing of A', async () => {
    const read = await c.asAgent('task.read', { recordId: workA.taskId }, workB.credential);
    expect(read.status).toBe(403);
    carriesNothingOfA(read);

    const own = await c.asAgent('task.read', { recordId: workB.taskId }, workB.credential);
    expect(own.status).toBe(200);
    expect(scopesIn(own)[0]?.delegation?.id).not.toBe(delegationA);
    carriesNothingOfA(own);
  });
});
