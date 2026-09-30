// SPDX-License-Identifier: AGPL-3.0-only
//
// The status select's choices (Stage 1 adds): `task.read` for a reader inside
// the business carries the business's own task states in the workflow's
// order, so the task page and the dock panel offer Waiting on client and On
// hold with the ids `task.set_state` takes. States are records of each
// business: another business's never appear, a refusal carries none, and the
// agent's read (the shared projection) carries none.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from '../commands/fixture.ts';
import { agentWorld, codeOf, type AgentWorld } from '../commands/agent-fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { readTaskSpine } from '../../packages/core-commands/src/commands/context.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import type { Member } from '../commands/fixture.ts';
import {
  CANARY,
  alpha,
  bravo,
  bravoWriter,
  clientAWriter,
  db,
  fresh,
  serverUrl,
  setUp,
  tearDown,
  writer,
} from '../commands/adhoc-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-read-states: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const SEEDED = [
  ['needs_review', 'Needs review', 'unstarted'],
  ['active', 'Active', 'started'],
  ['waiting_on_client', 'Waiting on client', 'started'],
  ['on_hold', 'On hold', 'backlog'],
  ['complete', 'Complete', 'completed'],
];

const read = async (business: BusinessId, by: Member, recordId: string) =>
  await executeRead(db.app, business, by.presented, { read: 'task.read', recordId });

const idsOf = async (business: BusinessId): Promise<readonly string[]> =>
  await db.app.withBusiness(business, async (tx) =>
    (await readTaskSpine(tx)).states.map((state) => state.id),
  );

const statesIn = (answer: unknown): unknown => (answer as { readonly states?: unknown }).states;

describe.skipIf(serverUrl === undefined)('Stage 1 adds: the states task.read offers', () => {
  beforeAll(async () => {
    await setUp();
  }, 180_000);

  afterAll(async () => {
    await tearDown();
  });

  it('carries the business’s five states in the workflow’s order, each with its id', async () => {
    const task = await fresh(alpha, writer, 'a status select');
    const answer = await read(alpha, writer, task.recordId);
    const states = statesIn(answer) as readonly Record<string, string>[];
    expect(
      states.map((state) => [state['key'], state['label'], state['machineCategory']]),
    ).toStrictEqual(SEEDED);
    expect(states.map((state) => state['id'])).toStrictEqual(await idsOf(alpha));
  });

  it('another business: its task is not found, with none of its states; its own reader gets its own', async () => {
    const foreign = await fresh(bravo, bravoWriter, CANARY);
    const bravoIds = await idsOf(bravo);
    const refused = await read(alpha, writer, foreign.recordId);
    expect(codeOf(refused as never)).toBe('NOT_FOUND');
    const text = JSON.stringify(refused);
    expect(text).not.toContain(CANARY);
    for (const id of bravoIds) expect(text).not.toContain(id);
    const own = statesIn(await read(bravo, bravoWriter, foreign.recordId)) as readonly {
      readonly id: string;
    }[];
    expect(own.map((state) => state.id)).toStrictEqual(bravoIds);
    expect((await idsOf(alpha)).some((id) => bravoIds.includes(id))).toBe(false);
  });

  it('another client in the same business: a reader of client A’s task is refused client B’s, with no states', async () => {
    const taskA = await fresh(alpha, writer, 'client A');
    const taskB = await fresh(alpha, writer, CANARY);
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, clientAWriter, 'read', { kind: 'record', id: taskA.recordId });
    });
    const own = statesIn(await read(alpha, clientAWriter, taskA.recordId)) as readonly unknown[];
    expect(own).toHaveLength(SEEDED.length);
    const refused = await read(alpha, clientAWriter, taskB.recordId);
    expect(codeOf(refused as never)).not.toBe('not-a-refusal');
    expect(statesIn(refused)).toBeUndefined();
    expect(JSON.stringify(refused)).not.toContain(CANARY);
  });
});

describe.skipIf(serverUrl === undefined)(
  'Stage 1 adds: the states task.read offers, under a live delegation',
  () => {
    let world: AgentWorld;

    beforeAll(async () => {
      world = await agentWorld('rs', `read-states-${randomUUID().slice(0, 8)}`);
    }, 180_000);

    afterAll(async () => {
      await world?.drop();
    });

    it('an agent reading its own task is sent no states, and another task nothing', async () => {
      const decider = await world.decider('decider');
      const other = await world.asPerson(decider, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: CANARY },
      });
      const otherId = isCommandRefusal(other) ? '' : (other.recordId ?? '');
      const picked = await world.pickUp(decider, 'the agent’s task');
      const own = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
        picked.credential,
      );
      expect(codeOf(own)).toBe('not-a-refusal');
      expect(JSON.stringify(own)).not.toMatch(/"states"/u);
      const foreign = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: otherId },
        picked.credential,
      );
      expect(codeOf(foreign)).not.toBe('not-a-refusal');
      expect(JSON.stringify(foreign)).not.toContain(CANARY);
      expect(JSON.stringify(foreign)).not.toMatch(/"states"/u);
    });
  },
);
