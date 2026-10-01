// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-2 isolation: the scoped `task.todos` (a teammate, a client) makes the
// three crossings, each a real one with its status checked and a stored
// canary that must never appear in any body, refusals included: another
// business, another client in the same business, and another person's agent
// under a live delegation. A scope reaches no further than the reader's own
// `task:read`: a reader held to one client's task is refused the whole list,
// so a teammate's task they cannot read is never listed, named or counted.

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
    'task-todos-scope-isolation: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

let w: TimeWorld;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('tdsi');
  for (const [business, member] of [
    [w.alpha, w.ada],
    [w.bravo, w.bravoOwner],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- one business at a time
    await w.db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, member, 'assign');
      await grantTo(tx, member, 'share');
    });
  }
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

async function readAs(business: BusinessId, member: Member, scope: Record<string, unknown>) {
  const answer = await executeRead(w.db.app, business, member.presented, {
    read: 'task.todos',
    ...scope,
  } as never);
  return { code: codeOf(answer as CommandResult), text: JSON.stringify(answer) };
}

describe.skipIf(serverUrl === undefined)('MP-7-2 isolation: another business', () => {
  it('another business’s person is not found, and its client’s tasks are never listed', async () => {
    const client = randomUUID();
    const foreign = await assignTo(w, w.bravo, w.bravoOwner, CANARY, w.bravoOwner, {}, client);
    const person = await readAs(w.alpha, w.ada, { person: w.bravoOwner.personId });
    expect(person.code).toBe('NOT_FOUND');
    const byClient = await readAs(w.alpha, w.ada, { client });
    expect(byClient.code).toBe('not-a-refusal');
    expect(JSON.parse(byClient.text)).toMatchObject({ todos: [] });
    for (const read of [person, byClient]) {
      expect(read.text).not.toContain(CANARY);
      expect(read.text).not.toContain(foreign);
    }
    // The control: bravo's owner reads the canary under both scopes, in bravo.
    for (const scope of [{ person: w.bravoOwner.personId }, { client }]) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      const theirs = await todosOf(w, w.bravo, w.bravoOwner, scope);
      expect(theirs.todos.map((todo) => todo.title)).toContain(CANARY);
    }
  });
});

describe.skipIf(serverUrl === undefined)('MP-7-2 isolation: another client', () => {
  it('a reader held to client A’s task is refused a teammate’s and client B’s lists, with no count', async () => {
    const [clientA, clientB] = [randomUUID(), randomUUID()];
    const taskA = await assignTo(w, w.alpha, w.ada, 'client A work', w.noah, {}, clientA);
    const taskB = await assignTo(w, w.alpha, w.ada, `${CANARY}-b`, w.noah, {}, clientB);
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, w.clientA, 'read', { kind: 'record', id: taskA });
    });
    for (const scope of [{ person: w.noah.personId }, { client: clientB }, { client: clientA }]) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      const read = await readAs(w.alpha, w.clientA, scope);
      expect(read.code, JSON.stringify(scope)).toBe('SCOPE_NOT_GRANTED');
      expect(read.text).not.toContain(CANARY);
      expect(read.text).not.toContain(taskB);
      // Not even the task they may read, and no count of what was held back.
      expect(read.text).not.toContain(taskA);
      expect(read.text).not.toMatch(/todos|withheld|count/u);
    }
    // The control: a reader of the whole business sees the canary in Noah's list.
    const noahs = await todosOf(w, w.alpha, w.ada, { person: w.noah.personId });
    expect(noahs.todos.map((todo) => todo.id)).toEqual(expect.arrayContaining([taskA, taskB]));
  });
});

/** A person with a teammate holding a to-do carrying the canary, and an agent under the person's delegation. */
async function agentBesideTeammate() {
  const world = await agentWorld('tdsa', `todo-scope-agent-${randomUUID().slice(0, 8)}`);
  const decider = await world.decider('decider');
  const mate = await world.decider('mate');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, decider, 'assign');
  });
  const picked = await world.pickUp(decider, 'the agent’s task');
  const made = await world.asPerson(decider, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: CANARY },
  });
  if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
  const assigned = await world.asPerson(decider, {
    command: 'task.assign',
    operationId: randomUUID(),
    recordId: made.recordId,
    expectedRevision: made.revision,
    fields: { assignee: mate.personId },
  });
  if (isCommandRefusal(assigned)) throw new Error(`task.assign refused ${assigned.code}`);
  return { world, decider, mate, picked };
}

describe.skipIf(serverUrl === undefined)(
  'MP-7-2 isolation: another person’s agent under a live delegation',
  () => {
    let world: AgentWorld;
    let decider: Member;
    let mate: Member;
    let picked: { readonly taskId: string; readonly credential: string };

    beforeAll(async () => {
      ({ world, decider, mate, picked } = await agentBesideTeammate());
    }, 180_000);

    afterAll(async () => {
      await world?.drop();
    });

    it('the agent is refused a teammate’s to-dos, and the canary never reaches it', async () => {
      // The control: the principal reads the canary in the teammate's list.
      const own = await executeRead(world.db.app, world.business, decider.presented, {
        read: 'task.todos',
        person: mate.personId,
      } as never);
      expect(codeOf(own as CommandResult)).toBe('not-a-refusal');
      expect(JSON.stringify(own)).toContain(CANARY);
      for (const scope of [{ person: mate.personId }, { client: randomUUID() }]) {
        // eslint-disable-next-line no-await-in-loop -- one read at a time
        const answer = await world.asAgent(
          { command: 'task.todos', operationId: randomUUID(), ...scope },
          picked.credential,
        );
        expect(codeOf(answer), JSON.stringify(scope)).toBe('DELEGATION_EXCLUDES_OPERATION');
        expect(JSON.stringify(answer)).not.toContain(CANARY);
      }
    });
  },
);
