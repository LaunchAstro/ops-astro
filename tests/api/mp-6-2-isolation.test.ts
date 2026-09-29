// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2 isolation, through the real boundary and a fresh Postgres.
//
// What MP-6-2 adds that could carry one party's run to another: the run's
// start and the gate's raised time on `task.read`, and the page drawn from the
// versions, checks and decisions the same read carries (hero, artefacts, the
// activity log). Each crossing asks from the other side, checks the status,
// and checks that no body carries the canary in A's title and in the name of
// the check A's agent recorded, A's task, versions or check, refusals
// included.
//
// The crossings: another business (the same login in Bravo); another client in
// the same business (two people, each holding read on one task alone); and
// another person's work under a live delegation (the agent working task B
// under its pickup's delegation reaching task A).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { authorised, post, tokenFor, type Answer } from './fixture.ts';
import type { Controls } from './controls-fixture.ts';
import { checksWorld, pickedUpOn, type PickedUp } from './mp-6-1-checks-fixture.ts';
import { handBack } from './mp-6-2-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Paged {
  readonly versions: readonly {
    readonly versionId: string;
    readonly runStartedAt: string | null;
    readonly gate: { readonly raisedAt: string } | null;
    readonly checks: readonly { readonly id: string }[];
  }[];
}

// eslint-disable-next-line max-lines-per-function -- one world of two businesses, every crossing on it
describe.skipIf(serverUrl === undefined)('MP-6-2 isolation', () => {
  let c: Controls;
  const canary = `CANARY-${randomUUID()}`;
  let workA: PickedUp;
  let workB: PickedUp;
  let foreign: readonly string[] = [];
  let clientOne: Member;
  let clientTwo: Member;
  let both: Member;

  async function enrolClients(): Promise<void> {
    const { db, business } = c.fixture;
    clientOne = await enrol(db.app, business, 'client-one');
    clientTwo = await enrol(db.app, business, 'client-two');
    both = await enrol(db.app, business, 'both');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, clientOne, 'read', { kind: 'record', id: workA.taskId });
      await grantTo(tx, clientTwo, 'read', { kind: 'record', id: workB.taskId });
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

  /** A's run: a check whose name carries the canary, handed back for review. */
  async function runA(): Promise<void> {
    workA = await pickedUpOn(c, 'page_client_one');
    const checked = await c.asAgent(
      'task.check',
      { leaseId: workA.leaseId, fence: workA.fence, name: `${canary} check`, outcome: 'passed' },
      workA.credential,
    );
    expect(checked.status).toBe(200);
    await handBack(c, workA);
    const readA = await c.asPerson('task.read', { recordId: workA.taskId });
    const task = readA.body['task'] as { revision: number; proposals: readonly Paged[] };
    const titled = await c.asPerson('task.update', {
      recordId: workA.taskId,
      expectedRevision: task.revision,
      fields: { title: `${canary} client one` },
    });
    expect(titled.status).toBe(200);
    const versions = task.proposals[0]?.versions ?? [];
    foreign = [
      canary,
      workA.taskId,
      ...versions.map((one) => one.versionId),
      ...versions.flatMap((one) => one.checks.map((each) => each.id)),
    ];
    expect(foreign.length).toBeGreaterThanOrEqual(5);
  }

  beforeAll(async () => {
    ({ c } = await checksWorld('mp_6_2_isolation'));
    await runA();
    workB = await pickedUpOn(c, 'page_client_two');
    await enrolClients();
  }, 180_000);

  afterAll(async () => await c?.drop());

  const carriesNothingOfA = (answer: Answer): void => {
    const text = JSON.stringify(answer.body);
    for (const each of foreign) expect(text).not.toContain(each);
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

  it('another client in the same business: each reads its own run’s page alone', async () => {
    const one = await c.asPerson('task.read', { recordId: workA.taskId }, clientOne);
    expect(one.status).toBe(200);
    const paged = (one.body['task'] as { proposals: readonly Paged[] }).proposals[0];
    expect(paged?.versions.at(-1)?.runStartedAt).not.toBeNull();
    expect(paged?.versions[0]?.gate?.raisedAt).toBeTypeOf('string');
    expect(JSON.stringify(one.body)).toContain(canary);
    expect(JSON.stringify(one.body)).not.toContain(workB.taskId);

    const two = await c.asPerson('task.read', { recordId: workB.taskId }, clientTwo);
    expect(two.status).toBe(200);
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
    carriesNothingOfA(own);
  });
});
