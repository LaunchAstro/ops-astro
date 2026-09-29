// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-1 isolation and MP-6-1 one awaiting-review read, through the real
// boundary and a fresh Postgres.
//
// What MP-6-1 adds that could carry one party's run to another: the checks a
// run records (`task.check`, read back on `task.read`) and the one list of
// gates waiting on a decision (`gate.pending`). Each crossing plants a canary
// in task A's title and in a check A's run recorded, then asks from the other
// side and checks the status and that no body carries the canary, A's task id
// or A's gate id, refusals included.
//
// The crossings: another business (a person deciding in Bravo, reading in
// Alpha); another client in the same business (two people, each holding
// `decide` and `read` on one task alone); and another person's work under a
// live delegation (the agent working task B under its pickup's delegation
// reaching task A's lease, record and gates).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { authorised, post, tokenFor, type Answer } from './fixture.ts';
import { createControls, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world of two businesses, every crossing on it
describe.skipIf(serverUrl === undefined)('MP-6-1 isolation', () => {
  let c: Controls;
  const canary = `CANARY-${randomUUID()}`;
  let taskA = '';
  let gateA = '';
  let taskB = '';
  let runA = '';
  let runB = '';
  let gateB = '';
  let leaseA = { leaseId: '', fence: 0, credential: '' };
  let leaseB = { leaseId: '', fence: 0, credential: '' };
  let clientOne: Member;
  let clientTwo: Member;
  let both: Member;
  let bothInBravo: Member;

  /** A task with a pending gate, and one with an approved run the agent picked up. */
  async function pending(title: string) {
    const task = await c.createTask(title);
    const proposal = await c.propose(task.id, task.revision, 'await_review');
    return { taskId: task.id, gateId: String(proposal['gateId']) };
  }
  async function working(title: string, purpose: string) {
    const task = await c.createTask(title);
    const reservationId = await c.approve(await c.propose(task.id, task.revision, purpose));
    const picked = await c.pickup(reservationId, 600);
    return {
      taskId: task.id,
      lease: {
        leaseId: String(picked['leaseId']),
        fence: Number(picked['fence']),
        credential: String(picked['credential']),
      },
    };
  }

  /** Client one reads and decides A's tasks, client two B's; `both` reads the whole business. */
  async function enrolClients(): Promise<void> {
    const { db, business } = c.fixture;
    clientOne = await enrol(db.app, business, 'client-one');
    clientTwo = await enrol(db.app, business, 'client-two');
    both = await enrol(db.app, business, 'both');
    await db.app.withBusiness(business, async (tx) => {
      for (const [member, task] of [
        [clientOne, taskA],
        [clientOne, runA],
        [clientTwo, taskB],
        [clientTwo, runB],
      ] as const) {
        // eslint-disable-next-line no-await-in-loop -- issueGrant reads the granter's rows
        await grantTo(tx, member, 'read', { kind: 'record', id: task });
        // eslint-disable-next-line no-await-in-loop -- as above
        await grantTo(tx, member, 'decide', { kind: 'record', id: task });
      }
      await grantTo(tx, both, 'read');
    });
  }

  /** `both` again in business Bravo, with read, decide and write there. */
  async function enrolInBravo(): Promise<void> {
    const { db } = c.fixture;
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
      bothInBravo = { personId, actorId, presented: both.presented };
      await grantTo(tx, bothInBravo, 'read');
      await grantTo(tx, bothInBravo, 'decide');
      // Write too, so a check naming A's lease reaches the lease lookup itself.
      await grantTo(tx, bothInBravo, 'write');
    });
  }

  beforeAll(async () => {
    c = await createControls('mp_6_1_isolation');
    const a = await working(`${canary} client one run`, 'worked_one');
    runA = a.taskId;
    leaseA = a.lease;
    const b = await working('made-up client two run', 'worked_two');
    runB = b.taskId;
    leaseB = b.lease;
    const recorded = await c.asAgent(
      'task.check',
      {
        leaseId: leaseA.leaseId,
        fence: leaseA.fence,
        name: `${canary} check`,
        outcome: 'passed',
        note: canary,
      },
      leaseA.credential,
    );
    expect(recorded.status).toBe(200);
    ({ taskId: taskA, gateId: gateA } = await pending(`${canary} client one`));
    ({ taskId: taskB, gateId: gateB } = await pending('made-up client two task'));
    await enrolClients();
    await enrolInBravo();
  }, 180_000);

  afterAll(async () => await c?.drop());

  const carriesNothingOfA = (answer: Answer): void => {
    const text = JSON.stringify(answer.body);
    expect(text).not.toContain(canary);
    expect(text).not.toContain(taskA);
    expect(text).not.toContain(runA);
    expect(text).not.toContain(gateA);
    expect(text).not.toContain(leaseA.leaseId);
  };

  const inBravo = async (name: string, body: Record<string, unknown>): Promise<Answer> =>
    await post(
      c.api,
      `/api/b/bravo/${name.replace('.', '/')}`,
      { operationId: randomUUID(), ...body },
      authorised(await tokenFor(both.presented.subject)),
    );

  describe('MP-6-1 one awaiting-review read', () => {
    it('lists every pending gate to a business-wide decider, current versions only', async () => {
      const answer = await c.asPerson('gate.pending', {});
      expect(answer.status).toBe(200);
      const gates = (answer.body['awaiting'] as { gateId: string; taskId: string }[]).map(
        (row) => row.gateId,
      );
      expect(gates).toContain(gateA);
      expect(gates).toContain(gateB);
    });

    it('drops a gate once decided, and refuses a caller holding no decide', async () => {
      const fresh = await pending('decided and gone');
      const before = await c.asPerson('gate.pending', {});
      expect(JSON.stringify(before.body)).toContain(fresh.gateId);
      const read = await c.asPerson('task.read', { recordId: fresh.taskId });
      const version = (read.body['task'] as { proposals: { versions: { versionId: string }[] }[] })
        .proposals[0]?.versions[0]?.versionId;
      const decided = await c.asPerson('task.decide', {
        gateId: fresh.gateId,
        versionId: version,
        decision: 'reject',
        note: 'not this one',
      });
      expect(decided.status).toBe(200);
      const after = await c.asPerson('gate.pending', {});
      expect(JSON.stringify(after.body)).not.toContain(fresh.gateId);

      const readerOnly = await c.asPerson('gate.pending', {}, c.reader);
      expect(readerOnly.status).toBe(403);
      expect(readerOnly.body['code']).toBe('SCOPE_NOT_GRANTED');
    });
  });

  // eslint-disable-next-line max-lines-per-function -- the three crossings, each read from both sides
  describe('MP-6-1 isolation', () => {
    it('another business: Bravo’s list and Alpha’s refusal carry nothing of A', async () => {
      const bravoList = await inBravo('gate.pending', {});
      expect(bravoList.status).toBe(200);
      expect(bravoList.body['awaiting']).toStrictEqual([]);
      carriesNothingOfA(bravoList);

      // In Alpha the same login holds read and no decide.
      const alphaList = await c.asPerson('gate.pending', {}, both);
      expect(alphaList.status).toBe(403);
      carriesNothingOfA(alphaList);

      // A's lease named from Bravo names nothing there.
      const check = await inBravo('task.check', {
        leaseId: leaseA.leaseId,
        fence: leaseA.fence,
        name: 'from bravo',
        outcome: 'passed',
      });
      expect(check.status).toBe(403);
      expect(check.body['code']).toBe('LEASE_NOT_OWNED');
      carriesNothingOfA(check);
      const bravoRead = await inBravo('task.read', { recordId: runA });
      expect(bravoRead.status).toBe(404);
      carriesNothingOfA(bravoRead);
    });

    it('another client in the same business: each decider sees its own task’s gates only', async () => {
      const two = await c.asPerson('gate.pending', {}, clientTwo);
      expect(two.status).toBe(200);
      expect((two.body['awaiting'] as { gateId: string }[]).map((row) => row.gateId)).toStrictEqual(
        [gateB],
      );
      carriesNothingOfA(two);

      const one = await c.asPerson('gate.pending', {}, clientOne);
      expect((one.body['awaiting'] as { gateId: string }[]).map((row) => row.gateId)).toStrictEqual(
        [gateA],
      );

      const read = await c.asPerson('task.read', { recordId: runA }, clientTwo);
      expect(read.status).toBe(403);
      carriesNothingOfA(read);
    });

    it('another person’s work under a live delegation: B’s agent reaches nothing of A', async () => {
      const check = await c.asAgent(
        'task.check',
        { leaseId: leaseA.leaseId, fence: leaseA.fence, name: 'across', outcome: 'failed' },
        leaseB.credential,
      );
      expect(check.status).toBeGreaterThanOrEqual(400);
      carriesNothingOfA(check);
      expect(
        await c.count(`select count(*)::text as n from public.run_checks where task_id = $1`, [
          runA,
        ]),
      ).toBe(1);

      const read = await c.asAgent('task.read', { recordId: runA }, leaseB.credential);
      expect(read.status).toBe(403);
      carriesNothingOfA(read);

      const list = await c.asAgent('gate.pending', {}, leaseB.credential);
      expect(list.status).toBeGreaterThanOrEqual(400);
      carriesNothingOfA(list);

      // B's own read shows B's run and not A's check.
      const own = await c.asAgent('task.read', { recordId: runB }, leaseB.credential);
      expect(own.status).toBe(200);
      carriesNothingOfA(own);
    });
  });
});
