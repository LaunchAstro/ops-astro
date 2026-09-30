// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-1's crossings for `task.todos`, each a real one with its status
// checked and a stored canary that must never appear in any body, refusals
// included: another business, another client in the same business, and
// another person's agent under a live delegation.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { grantTo, type Member } from './fixture.ts';
import { agentWorld, codeOf, type AgentWorld } from './agent-fixture.ts';
import { timeWorld, type TimeWorld } from './time-world.ts';
import { assignTo, todosOf } from './todo-support.ts';

const CANARY = `canary-${randomUUID()}`;

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'task-todos-isolation: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

let w: TimeWorld;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('tdi');
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, w.ada, 'assign');
  });
  await w.db.app.withBusiness(w.bravo, async (tx) => {
    await grantTo(tx, w.bravoOwner, 'assign');
  });
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

async function readAs(business: BusinessId, member: Member) {
  const answer = await executeRead(w.db.app, business, member.presented, {
    read: 'task.todos',
  } as never);
  return { code: codeOf(answer as CommandResult), text: JSON.stringify(answer) };
}

describe.skipIf(serverUrl === undefined)('MP-7-1 isolation: another business', () => {
  it('another business’s to-dos are never listed, counted or named', async () => {
    const foreign = await assignTo(w, w.bravo, w.bravoOwner, CANARY, w.bravoOwner);
    const own = await assignTo(w, w.alpha, w.ada, 'alpha work', w.ada);
    const read = await readAs(w.alpha, w.ada);
    expect(read.code).toBe('not-a-refusal');
    expect(read.text).toContain(own);
    expect(read.text).not.toContain(CANARY);
    expect(read.text).not.toContain(foreign);
    // The control: the canary is bravo's owner's own to-do, in bravo.
    const theirs = await todosOf(w, w.bravo, w.bravoOwner);
    expect(theirs.todos.map((todo) => todo.title)).toContain(CANARY);
  });
});

describe.skipIf(serverUrl === undefined)('MP-7-1 isolation: another client', () => {
  it('a reader held to one client’s task is refused the list, and learns no canary', async () => {
    const taskA = await assignTo(w, w.alpha, w.ada, 'client A work', w.clientA);
    await assignTo(w, w.alpha, w.ada, `${CANARY}-b`, w.clientA);
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, w.clientA, 'read', { kind: 'record', id: taskA });
    });
    const read = await readAs(w.alpha, w.clientA);
    expect(read.code).toBe('SCOPE_NOT_GRANTED');
    expect(read.text).not.toContain(CANARY);
    expect(read.text).not.toContain('client A work');
  });
});

/** A person with a to-do carrying the canary, and an agent working under their delegation. */
async function agentBesideTodos() {
  const world = await agentWorld('tda', `todo-agent-${randomUUID().slice(0, 8)}`);
  const decider = await world.decider('decider');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, decider, 'assign');
  });
  const picked = await world.pickUp(decider, 'the agent’s task');
  const as = async (body: Record<string, unknown>) =>
    await world.asPerson(decider, { ...body, operationId: randomUUID() });
  const made = await as({ command: 'task.create', fields: { title: CANARY } });
  if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
  await as({
    command: 'task.assign',
    recordId: made.recordId,
    expectedRevision: made.revision,
    fields: { assignee: decider.personId },
  });
  return { world, decider, picked };
}

describe.skipIf(serverUrl === undefined)(
  'MP-7-1 isolation: another person’s agent under a live delegation',
  () => {
    let world: AgentWorld;
    let decider: Member;
    let picked: { readonly taskId: string; readonly credential: string };

    beforeAll(async () => {
      ({ world, decider, picked } = await agentBesideTodos());
    }, 180_000);

    afterAll(async () => {
      await world?.drop();
    });

    it('the agent is refused its principal’s to-dos, and the canary never reaches it', async () => {
      // The control: the canary is the principal's own to-do.
      const own = await executeRead(world.db.app, world.business, decider.presented, {
        read: 'task.todos',
      } as never);
      expect(codeOf(own as CommandResult)).toBe('not-a-refusal');
      expect(JSON.stringify(own)).toContain(CANARY);
      const answer = await world.asAgent(
        { command: 'task.todos', operationId: randomUUID() },
        picked.credential,
      );
      expect(codeOf(answer)).not.toBe('not-a-refusal');
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    });
  },
);
