// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-7 under a live delegation: an agent writes the description and its
// brief on its own delegated task through `task.update`, reads the brief back
// (it boots on it), and reaches no other task. Its other fields are the name,
// the due date and the page link (MP-4-8, MP-4-12); any field outside that
// list is refused to it by name.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { agentWorld, codeOf, detailOf, type AgentWorld, type PickedUp } from './agent-fixture.ts';
import { heldIn } from './writing-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task-writing-agent: DATABASE_URL is unset, so nothing below ran.');
}

const CANARY = `canary-${randomUUID()}`;

let world: AgentWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) {
    world = await agentWorld('wa', `writing-agent-${randomUUID().slice(0, 8)}`);
  }
}, 180_000);

afterAll(async () => {
  await world?.drop();
});

const held = async (recordId: string) => {
  const rows = await world.db.admin.execute<{ readonly title: string | null }>(
    `select txt_4 as title from public.records where id = $1`,
    [recordId],
  );
  return { ...(await heldIn(world.db, recordId)), title: rows[0]?.title };
};

const agentWrite = async (recordId: string, fields: Record<string, unknown>, credential: string) =>
  await world.asAgent(
    {
      command: 'task.update',
      operationId: randomUUID(),
      recordId,
      expectedRevision: Number((await held(recordId)).revision),
      fields,
    },
    credential,
  );

/** Someone else's task carrying the canary brief, and a task the agent holds. */
const scene = async (name: string): Promise<{ otherId: string; picked: PickedUp }> => {
  const decider = await world.decider(name);
  const other = await world.asPerson(decider, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: 'someone else’s', agent_brief: CANARY },
  });
  const otherId = isCommandRefusal(other) ? '' : (other.recordId ?? '');
  return { otherId, picked: await world.pickUp(decider, 'the agent’s task') };
};

describe.skipIf(serverUrl === undefined)('MP-4-7 isolation under a live delegation', () => {
  it('an agent writes the brief and the description on its own task, reads them back, and no other task', async () => {
    const { otherId, picked } = await scene('decider');
    const brief = await agentWrite(
      picked.taskId,
      { agent_brief: 'I will hold the spend.' },
      picked.credential,
    );
    expect(codeOf(brief)).toBe('not-a-refusal');
    const text = await agentWrite(picked.taskId, { description: 'Pacing.' }, picked.credential);
    expect(codeOf(text)).toBe('not-a-refusal');
    expect(await held(picked.taskId)).toMatchObject({
      agent_brief: 'I will hold the spend.',
      description: 'Pacing.',
    });
    // The agent boots on the brief, so its read carries it.
    const read = await world.asAgent(
      { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
      picked.credential,
    );
    const task = detailOf(read)['task'] as Record<string, unknown>;
    expect(task['agentBrief']).toBe('I will hold the spend.');

    const foreign = await agentWrite(otherId, { agent_brief: 'overwritten' }, picked.credential);
    expect(codeOf(foreign)).not.toBe('not-a-refusal');
    expect(JSON.stringify(foreign)).not.toContain(CANARY);
    expect((await held(otherId)).agent_brief).toBe(CANARY);
  });

  it('an agent writes no field outside its list through task.update, and a refusal writes nothing', async () => {
    // Its list is the two texts, the name, the due date and the page link
    // (MP-4-7, MP-4-8, MP-4-12). A field outside it is refused by name, and a
    // body mixing the two is refused whole.
    const { picked } = await scene('decider-2');
    const before = await held(picked.taskId);
    const bodies = [{ priority: 3 }, { lane: 'fast' }, { title: 'y', priority: 1 }];
    const answers: unknown[] = [];
    for (const fields of bodies) {
      // eslint-disable-next-line no-await-in-loop -- each write reads the revision the last left
      const answer = await agentWrite(picked.taskId, fields, picked.credential);
      answers.push(isCommandRefusal(answer) ? [answer.code, answer.names] : 'applied');
    }
    expect(answers).toStrictEqual([
      ['SCOPE_NOT_GRANTED', ['priority']],
      ['SCOPE_NOT_GRANTED', ['lane']],
      ['SCOPE_NOT_GRANTED', ['priority']],
    ]);
    expect(await held(picked.taskId)).toStrictEqual(before);
  });
});
