// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-06's security line, against a real database: the execution graph is
// never read across a business, a client or a person, the channel that tells
// an open page to read again carries no content, and a viewer whose access is
// revoked is refused at the next read.
//
// Each crossing has its positive control beside it, so a refusal here is not a
// read that never works. A canary title on the crossed task must never appear
// in any answer, refusals included, and neither may its id or its run's id.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  executeAgentCommand,
  executeRead,
  isCommandRefusal,
} from '../../packages/core-commands/src/index.ts';
import {
  connectListener,
  type BusinessId,
} from '../../packages/core-records/src/tenancy/database.ts';
import { LIVE_CHANNEL } from '../../apps/api/live.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  handbackBody,
  liveWork,
  openSchedules,
  propose,
  type Schedules,
} from './schedules-harness.ts';
import { cq8World } from './cq-8-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/aw-06-isolation: DATABASE_URL is unset, so nothing below ran.');
}

type Answer = Awaited<ReturnType<typeof executeRead>>;

const graphIn = (answer: Answer): unknown =>
  (answer as { readonly execution?: { readonly graph?: unknown } }).execution?.graph;

describe.skipIf(serverUrl === undefined)('AW-06 isolation and revocation', () => {
  let s: Schedules;

  const read = async (business: BusinessId, who: Member, recordId: string): Promise<Answer> =>
    await executeRead(s.db.app, business, who.presented, {
      read: 'task.execution',
      recordId,
    } as never);

  beforeAll(async () => {
    s = await openSchedules('aw06iso', 1_000_000);
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('AW-06 isolation: another business, another client in the same business and another person under a live delegation each read no graph and see no foreign id or canary', async () => {
    const canary = `aw06-canary-${randomUUID()}`;
    const crossed = await liveWork(s, canary, 1_000);
    const own = await liveWork(s, `aw06-own-${randomUUID()}`, 1_000);
    const world = cq8World(s);

    // Positive control: the owner reads the crossed task's graph, one node.
    const control = graphIn(await read(s.business, s.decider, crossed.taskId)) as {
      readonly nodes: readonly unknown[];
    };
    expect(control.nodes).toHaveLength(1);

    // 1. Another business: its member reads its own task, and names this one.
    const other = await world.party('aw06-other');
    const [otherTask] = other.tasks;
    if (otherTask === undefined) throw new Error('party: a task');
    const otherOwn = await read(other.id, other.member, otherTask.id);
    expect(isCommandRefusal(otherOwn), 'other business, own task').toBe(false);
    const business = await read(other.id, other.member, crossed.taskId);

    // 2. Two clients here with one grant each: each reaches its own shared
    // task's record and neither reaches the other's execution.
    await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'share'));
    const first = await world.client(s.business, s.decider, 'aw06-c1', own.taskId);
    const second = await world.client(s.business, s.decider, 'aw06-c2', crossed.taskId);
    const clientOwn = await executeRead(s.db.app, s.business, first.presented, {
      read: 'task.read',
      recordId: own.taskId,
    } as never);
    expect(isCommandRefusal(clientOwn), 'client reads its own shared task').toBe(false);
    const client = await read(s.business, first, crossed.taskId);
    const clientBack = await read(s.business, second, own.taskId);

    // 3. Another person's agent, under its own live delegation for its own
    // task, names the crossed task. The owning read serves no agent, so the
    // envelope answers; its own task still answers it (the positive control).
    const ownCredential = String(own.picked['credential']);
    const agentOwn = await asAgent(
      s,
      { command: 'task.read', operationId: randomUUID(), recordId: own.taskId },
      ownCredential,
    );
    expect(isCommandRefusal(agentOwn), 'the agent reads its own task').toBe(false);
    const person = await executeAgentCommand(s.db.app, s.business, s.agent, ownCredential, {
      command: 'task.execution',
      operationId: randomUUID(),
      recordId: crossed.taskId,
    } as never);

    const cases = [
      ['another business', business, 'NOT_FOUND'],
      ['client to client', client, 'NOT_FOUND'],
      ['client to client, back', clientBack, 'NOT_FOUND'],
      ['another person under a live delegation', person, 'DELEGATION_EXCLUDES_OPERATION'],
    ] as const;
    const hidden = [canary, crossed.taskId, String(crossed.picked['runId'])];
    for (const [name, answer, code] of cases) {
      expect(isCommandRefusal(answer), name).toBe(true);
      expect(codeOf(answer as never), name).toBe(code);
      const body = JSON.stringify(answer);
      expect(body, name).not.toContain('"graph"');
      expect(body, name).not.toContain('"nodes"');
      for (const needle of hidden) expect(body.includes(needle), `${name}: ${needle}`).toBe(false);
    }
    // The client-back case hides its own crossing's ids too.
    expect(JSON.stringify(clientBack)).not.toContain(own.taskId);

    // The other business's answer about its own task names nothing of this one's.
    const foreignOwn = JSON.stringify(otherOwn);
    for (const needle of hidden) expect(foreignOwn.includes(needle), needle).toBe(false);
  });

  it('AW-06 revoked: a viewer whose read is revoked is refused at the next read, and the channel carries only the topic, no content', async () => {
    const work = await liveWork(s, `aw06-revoked-${randomUUID()}`, 1_000);
    const viewer = await enrol(s.db.app, s.business, 'aw06-viewer');
    const grantId = await s.db.app.withBusiness(
      s.business,
      async (tx) => await grantTo(tx, viewer, 'read', { kind: 'record', id: work.taskId }),
    );
    expect(graphIn(await read(s.business, viewer, work.taskId))).toBeDefined();

    const payloads: string[] = [];
    const listener = connectListener(s.db.appUrl);
    try {
      let heard!: () => void;
      const listening = new Promise<void>((resolve) => {
        heard = resolve;
      });
      await listener.listen(LIVE_CHANNEL, (payload) => payloads.push(payload), heard);
      await listening;

      // The run moves (a hand-back), and a gate elsewhere on another task is
      // refused: every notification is a bare topic.
      appliedDetail(
        await asAgent(s, handbackBody(work.picked), String(work.picked['credential'])),
        'task.handback',
      );
      const other = await createTask(s, `aw06-revoked-gate-${randomUUID()}`);
      const proposal = await propose(s, other, { maximumMinor: 500, purpose: freshPurpose() });
      appliedDetail(
        await asPerson(s, {
          command: 'task.decide',
          operationId: randomUUID(),
          gateId: proposal['gateId'],
          versionId: proposal['versionId'],
          decision: 'reject',
          note: 'no',
        }),
        'task.decide reject',
      );
      const topic = `${s.business}:task:${work.taskId}`;
      const gateTopic = `${s.business}:task:${other}`;
      for (let waited = 0; waited < 50; waited += 1) {
        if (payloads.includes(topic) && payloads.includes(gateTopic)) break;
        // eslint-disable-next-line no-await-in-loop -- polling the listener's buffer
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(payloads).toContain(topic);
      expect(payloads).toContain(gateTopic);
      for (const payload of payloads) {
        expect(payload).toMatch(/^[0-9a-f-]{36}:task:[0-9a-f-]{36}$/);
      }
    } finally {
      await listener.close();
    }

    const revoked = await asPerson(s, {
      command: 'grant.revoke',
      operationId: randomUUID(),
      grantId,
    });
    expect(isCommandRefusal(revoked), JSON.stringify(revoked)).toBe(false);
    const after = await read(s.business, viewer, work.taskId);
    expect(isCommandRefusal(after)).toBe(true);
    expect(codeOf(after as never)).toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(after)).not.toContain('"graph"');
    expect(JSON.stringify(after)).not.toContain(String(work.picked['runId']));
  });
});
