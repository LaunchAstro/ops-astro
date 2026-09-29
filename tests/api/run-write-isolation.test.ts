// SPDX-License-Identifier: AGPL-3.0-only
//
// `run:write` isolation (ORCH25-SL12B-RUN), through the real boundary and a
// fresh Postgres.
//
// What the run collection adds that could carry one party's authority to
// another: the `run:write` pair pickup mints where the delegating person holds
// it. Each crossing asks from the other side, checks the status, and checks
// that no body carries the canary in A's title, A's task or A's delegation,
// refusals included; the call-time check every agent command makes answers
// for the pair itself.
//
// The crossings: another business (A's agent and credential at Bravo's
// address); another client in the same business (A's delegation asked for
// `run:write` on client two's task); and another person's work under a live
// delegation (a second agent, authorised by a person who holds no `run:write`,
// working task B). That person cannot delegate what they do not hold.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDelegatedAuthority,
  resolveDelegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo, installSpine } from '../commands/fixture.ts';
import { insertBusiness, insertLogin } from '../identity/fixture.ts';
import { authorised, post, tokenFor, type Answer } from './fixture.ts';
import { agentPath, detailOf, type Controls } from './controls-fixture.ts';
import { checksWorld, pickedUpOn, type PickedUp } from './mp-6-1-checks-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world of two businesses, every crossing on it
describe.skipIf(serverUrl === undefined)('run:write isolation', () => {
  let c: Controls;
  const canary = `CANARY-${randomUUID()}`;
  let workA: PickedUp;
  let taskB = '';
  let credentialB = '';
  let agentB = '';
  let tokenB = '';
  let foreign: readonly string[] = [];

  /** A second agent identity, linked by the writer, who holds no `run:write`. */
  async function agentOfWriter(writer: { actorId: string }): Promise<void> {
    const { db, business } = c.fixture;
    agentB = randomUUID();
    const subject = `agent-${randomUUID()}`;
    await db.app.withBusiness(business, async (tx) => {
      await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
        business,
        agentB,
      ]);
      const loginId = await insertLogin(tx, subject);
      await tx.query(
        `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
         values ($1, $2, $3, $4, $5)`,
        [business, randomUUID(), loginId, agentB, writer.actorId],
      );
    });
    tokenB = await tokenFor(subject);
  }

  beforeAll(async () => {
    const world = await checksWorld('run_write_isolation');
    c = world.c;
    const { db, business } = c.fixture;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, c.manager, 'write', undefined, false, 'run');
      // What pickup asks of the task, and no run grant at all.
      await grantTo(tx, world.writer, 'comment');
    });

    workA = await pickedUpOn(c, 'run_client_one');
    const readA = await c.asPerson('task.read', { recordId: workA.taskId });
    const titled = await c.asPerson('task.update', {
      recordId: workA.taskId,
      expectedRevision: (readA.body['task'] as { revision: number }).revision,
      fields: { title: `${canary} client one` },
    });
    expect(titled.status).toBe(200);
    const [delegationA] = await db.admin.execute<{ readonly id: string }>(
      `select delegation_id as id from public.leases where id = $1`,
      [workA.leaseId],
    );
    foreign = [canary, workA.taskId, workA.leaseId, delegationA?.id ?? 'missing'];

    await agentOfWriter(world.writer);
    const task = await c.createTask('client two');
    taskB = task.id;
    const proposal = await c.propose(task.id, task.revision, 'run_client_two');
    const reservationId = await c.approve(proposal);
    const picked = await post(
      c.api,
      agentPath('task.pickup'),
      { operationId: randomUUID(), reservationId, leaseSeconds: 600 },
      authorised(tokenB),
    );
    expect(picked.status).toBe(200);
    credentialB = String(detailOf(picked)['credential']);

    const bravo = await insertBusiness(db.app, 'bravo');
    await installSpine(db.app, bravo);
  }, 180_000);

  afterAll(async () => await c?.drop());

  const carriesNothingOfA = (answer: Answer): void => {
    const text = JSON.stringify(answer.body);
    for (const each of foreign) expect(text).not.toContain(each);
  };

  async function call(agent: string, credential: string, recordId: string) {
    return await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      const resolved = await resolveDelegation(tx, agent, credential);
      if (!resolved.ok) return resolved.refusal.code;
      const reach = await checkDelegatedAuthority(tx, resolved.value, {
        collection: 'run',
        action: 'write',
        scope: { kind: 'record', id: recordId },
      });
      return reach.ok ? 'ok' : reach.refusal.code;
    });
  }

  it('another business: A’s agent and credential at Bravo’s address reach nothing of A', async () => {
    const answer = await post(
      c.api,
      '/api/a/b/bravo/session/capabilities',
      { operationId: randomUUID() },
      {
        ...authorised(await tokenFor(c.fixture.agent.subject)),
        'x-agent-delegation': workA.credential,
      },
    );
    expect(answer.status).toBe(401);
    carriesNothingOfA(answer);
  });

  it('another client in the same business: A’s run:write reaches client one’s task alone', async () => {
    expect(await call(c.fixture.agentActorId, workA.credential, workA.taskId)).toBe('ok');
    expect(await call(c.fixture.agentActorId, workA.credential, taskB)).toBe(
      'DELEGATION_OUT_OF_PURPOSE',
    );
    const own = await c.asAgent('session.capabilities', {}, workA.credential);
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toContain(taskB);
  });

  it('another person’s work under a live delegation: B’s agent reaches nothing of A', async () => {
    expect(await call(agentB, credentialB, workA.taskId)).toBe('DELEGATION_OUT_OF_PURPOSE');
    const read = await post(
      c.api,
      agentPath('task.read'),
      { operationId: randomUUID(), recordId: workA.taskId },
      { ...authorised(tokenB), 'x-agent-delegation': credentialB },
    );
    expect(read.status).toBe(403);
    carriesNothingOfA(read);
  });

  it('a person without run:write cannot delegate it', async () => {
    expect(await call(agentB, credentialB, taskB)).toBe('DELEGATION_OUT_OF_PURPOSE');
    const own = await post(
      c.api,
      agentPath('session.capabilities'),
      { operationId: randomUUID() },
      { ...authorised(tokenB), 'x-agent-delegation': credentialB },
    );
    expect(own.status).toBe(200);
    const grants = own.body['grants'] as readonly { collection: string; action: string }[];
    expect(grants.map((g) => `${g.collection}:${g.action}`).toSorted()).toStrictEqual([
      'task:comment',
      'task:read',
      'task:write',
    ]);
    carriesNothingOfA(own);
  });
});
