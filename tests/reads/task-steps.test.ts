// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-4: subtasks as stored task records, against a real database.
//
// A subtask is a full task whose `parent` names another task (CS-15.19), so
// `task.read` carries the parent's steps, read with the parent in one query
// and filtered by the reader's own grants. A subtask carries its parent's
// business and client: it takes the client when it is made, a change of the
// parent's client carries down, and a subtask put under another client is
// refused. Every crossing plants a canary title a reader may not see and
// reads the whole body for it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { readTaskFamily } from '../../packages/core-records/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { agentWorld, detailOf, type AgentWorld } from '../commands/agent-fixture.ts';
import {
  serverUrl,
  CANARY,
  alpha,
  owner,
  pairReader,
  ids,
  seeded,
  command,
  revisionOf,
  read,
  stepsOf,
  titles,
  seed,
  dropSteps,
} from './steps-world.ts';

if (serverUrl === undefined) {
  console.warn('task-steps: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await seed();
}, 180_000);

afterAll(dropSteps);

describe.skipIf(serverUrl === undefined)('MP-4-4 subtask stored', () => {
  it('parent and children read back in one query', async () => {
    let queries = 0;
    const family = await seeded().app.withBusiness(alpha, async (tx) => {
      const counted: TenantQuery = {
        ...tx,
        query: async (sql, params) => {
          queries += 1;
          return await tx.query(sql, params);
        },
      };
      const types = await tx.query<{ readonly id: string }>(
        `select id from public.record_types where business_id = $1 and key = 'task'`,
        [alpha],
      );
      return await readTaskFamily(counted, types[0]?.id ?? '', ids['parent'] ?? '');
    });
    expect(queries).toBe(1);
    expect(family.parent?.id).toBe(ids['parent']);
    // The stray child is this business's, so the stored family holds it; the
    // grant filter on the read decides who is shown it.
    expect(family.children.map((child) => child.id).toSorted()).toStrictEqual(
      [ids['first'], ids['second'], ids['stray']].toSorted(),
    );
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-4 subtask stored', () => {
  it('task.read carries the steps in their order, each a full task', async () => {
    const { steps } = await stepsOf(alpha, owner, ids['parent'] ?? '');
    // In the order they were added; the planted stray is this business's own
    // and the owner reads the whole business, so it is a step here too.
    expect(titles(steps).filter((title) => title !== CANARY)).toStrictEqual([
      'Write the copy',
      'Check the forms',
    ]);
    const first = steps[0];
    expect(first?.id).toBe(ids['first']);
    expect(first?.key).toMatch(/^T-\d+$/u);
    expect(first?.done).toBe(false);
    expect(first?.archived).toBeNull();
    expect(first?.state?.machineCategory).toBe('unstarted');
    // A subtask is a task: it reads on its own, with a parent of its own.
    const own = await read(alpha, owner, ids['first'] ?? '');
    expect(isCommandRefusal(own)).toBe(false);
  });

  it('a subtask completed reads as done at once', async () => {
    const second = ids['second'] ?? '';
    await command(alpha, owner, {
      command: 'task.complete',
      recordId: second,
      expectedRevision: await revisionOf(second),
    });
    const { steps } = await stepsOf(alpha, owner, ids['parent'] ?? '');
    expect(steps.find((step) => step.id === second)?.done).toBe(true);
    await command(alpha, owner, {
      command: 'task.reopen',
      recordId: second,
      expectedRevision: await revisionOf(second),
      reason: 'put back for the next case',
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-4 isolation', () => {
  it('another business: its task pointing at the parent is never a step', async () => {
    const { steps, body } = await stepsOf(alpha, owner, ids['parent'] ?? '');
    expect(steps.map((step) => step.id)).not.toContain(ids['foreign']);
    expect(body).not.toContain(ids['foreign']);
    const across = await read(alpha, owner, ids['foreign'] ?? '');
    expect(isCommandRefusal(across) ? across.code : 'answered').toBe('NOT_FOUND');
  });

  it('another client in the same business: a reader of the parent sees only the steps they hold', async () => {
    const { steps, body } = await stepsOf(alpha, pairReader, ids['parent'] ?? '');
    expect(titles(steps)).toStrictEqual(['Write the copy']);
    expect(body).not.toContain(CANARY);
    expect(body).not.toContain(ids['stray']);
    expect(body).not.toContain(ids['second']);
    const direct = await read(alpha, pairReader, ids['stray'] ?? '');
    expect(isCommandRefusal(direct) ? direct.code : 'answered').toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(direct)).not.toContain(CANARY);
  });
});

describe.skipIf(serverUrl === undefined)(
  'MP-4-4 isolation: an agent under a live delegation',
  () => {
    let world: AgentWorld;

    beforeAll(async () => {
      world = await agentWorld('sta', `steps-agent-${randomUUID().slice(0, 8)}`);
    }, 180_000);

    afterAll(async () => {
      await world?.drop();
    });

    it('reads no step of its task, and no subtask title reaches it', async () => {
      const decider = await world.decider('decider');
      const picked = await world.pickUp(decider, 'the agent’s task');
      const made = await world.asPerson(decider, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: CANARY },
        parentId: picked.taskId,
      });
      expect(isCommandRefusal(made)).toBe(false);
      const own = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
        picked.credential,
      );
      const task = detailOf(own)['task'] as { steps: unknown };
      expect(task.steps).toStrictEqual([]);
      expect(JSON.stringify(own)).not.toContain(CANARY);
      const step = isCommandRefusal(made) ? '' : (made.recordId ?? '');
      const direct = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: step },
        picked.credential,
      );
      expect(isCommandRefusal(direct)).toBe(true);
      expect(JSON.stringify(direct)).not.toContain(CANARY);
    });
  },
);
