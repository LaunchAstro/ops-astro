// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-11 isolation for the tag commands, the vocabulary and `task.read`'s
// tags: another business, another client in the same business, and another
// person's agent under a live delegation, each with a canary tag that never
// reaches an answer, refusals included.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { grantTo, type Member } from './fixture.ts';
import { agentWorld, codeOf, detailOf, type AgentWorld } from './agent-fixture.ts';
import { WHOLE, timeWorld, type TimeWorld } from './time-world.ts';

/** A tag name is at most 40 characters, so the canary is a short one. */
const CANARY = `canary-${randomUUID().slice(0, 30)}`;

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'task-tags-isolation: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

let w: TimeWorld;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('tgi');
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, w.ada, 'write', WHOLE, false, 'tag');
  });
  await w.db.app.withBusiness(w.bravo, async (tx) => {
    await grantTo(tx, w.bravoOwner, 'write', WHOLE, false, 'tag');
  });
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

const tagIdOf = (answer: CommandResult): string => {
  if (isCommandRefusal(answer)) throw new Error(`refused ${answer.code}`);
  return String((answer.detail as { tagId?: unknown }).tagId);
};

async function readAs(business: BusinessId, member: Member, body: Record<string, unknown>) {
  const answer = await executeRead(w.db.app, business, member.presented, body as never);
  return { answer, text: JSON.stringify(answer) };
}

async function tagRows(business: BusinessId, taskId: string) {
  return await w.db.admin.execute<{ readonly name: string }>(
    `select g.name from public.task_tags t
       join public.tags g on g.business_id = t.business_id and g.id = t.tag_id
      where t.business_id = $1 and t.task_id = $2 order by g.name`,
    [business, taskId],
  );
}

describe.skipIf(serverUrl === undefined)('MP-4-11 isolation: another business', () => {
  it('another business’s tags are never listed, added, removed or named', async () => {
    const foreignTask = await w.fresh(w.bravo, w.bravoOwner, 'bravo work');
    const foreignTag = tagIdOf(
      await w.as(w.bravo, w.bravoOwner, { command: 'tag.create', name: CANARY }),
    );
    await w.as(w.bravo, w.bravoOwner, {
      command: 'task.add_tag',
      recordId: foreignTask,
      tagId: foreignTag,
    });
    const own = await w.fresh(w.alpha, w.ada, 'alpha work');
    for (const body of [
      { command: 'task.add_tag', recordId: own, tagId: foreignTag },
      { command: 'task.add_tag', recordId: foreignTask, tagId: foreignTag },
      { command: 'task.remove_tag', recordId: foreignTask, tagId: foreignTag },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const answer = await w.as(w.alpha, w.ada, body);
      expect(codeOf(answer), body.command).toBe('NOT_FOUND');
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
    // Its name is free here: the vocabulary is per business.
    const same = await w.as(w.alpha, w.ada, { command: 'tag.create', name: CANARY.toUpperCase() });
    expect(codeOf(same)).toBe('not-a-refusal');
    const listed = await readAs(w.alpha, w.ada, { read: 'tag.list' });
    expect(listed.text).not.toContain(foreignTag);
    expect(listed.text).not.toContain(CANARY);
    expect(await tagRows(w.alpha, own)).toHaveLength(0);
    expect((await tagRows(w.bravo, foreignTask)).map((row) => row.name)).toStrictEqual([CANARY]);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-11 isolation: another client', () => {
  it('a client A editor tags client A’s task, and never lists or touches client B’s', async () => {
    const taskA = await w.fresh(w.alpha, w.ada, 'client A');
    const taskB = await w.fresh(w.alpha, w.ada, 'client B');
    const shared = tagIdOf(await w.as(w.alpha, w.ada, { command: 'tag.create', name: 'Shared' }));
    // The business test above made the canary's upper case here; this one is its own.
    const secret = tagIdOf(
      await w.as(w.alpha, w.ada, { command: 'tag.create', name: `${CANARY}-b` }),
    );
    await w.as(w.alpha, w.ada, { command: 'task.add_tag', recordId: taskB, tagId: secret });
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, w.clientA, 'read', { kind: 'record', id: taskA });
      await grantTo(tx, w.clientA, 'write', { kind: 'record', id: taskA });
    });
    const add = await w.as(w.alpha, w.clientA, {
      command: 'task.add_tag',
      recordId: taskA,
      tagId: shared,
    });
    expect(codeOf(add)).toBe('not-a-refusal');
    const readA = await readAs(w.alpha, w.clientA, { read: 'task.read', recordId: taskA });
    expect(readA.text).toContain('Shared');
    expect(readA.text).not.toContain(CANARY);
    // The business's vocabulary is not a client's to read.
    const listed = await readAs(w.alpha, w.clientA, { read: 'tag.list' });
    expect(codeOf(listed.answer as CommandResult)).toBe('SCOPE_NOT_GRANTED');
    expect(listed.text).not.toContain(CANARY);
    for (const body of [
      { command: 'task.add_tag', recordId: taskB, tagId: shared },
      { command: 'task.remove_tag', recordId: taskB, tagId: secret },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const answer = await w.as(w.alpha, w.clientA, body);
      expect(['NOT_FOUND', 'SCOPE_NOT_GRANTED'], body.command).toContain(codeOf(answer));
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
    expect((await tagRows(w.alpha, taskB)).map((row) => row.name)).toStrictEqual([`${CANARY}-b`]);
    expect((await tagRows(w.alpha, taskA)).map((row) => row.name)).toStrictEqual(['Shared']);
  });
});

/** An agent's picked-up task carrying one tag, and a canary tag elsewhere in its business. */
async function agentWithTags() {
  const world = await agentWorld('tga', `tag-agent-${randomUUID().slice(0, 8)}`);
  const decider = await world.decider('decider');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, decider, 'write', WHOLE, false, 'tag');
  });
  const picked = await world.pickUp(decider, 'the agent’s task');
  const as = async (body: Record<string, unknown>) =>
    await world.asPerson(decider, { ...body, operationId: randomUUID() });
  const own = tagIdOf(await as({ command: 'tag.create', name: 'On its task' }));
  const secret = tagIdOf(await as({ command: 'tag.create', name: CANARY }));
  await as({ command: 'task.add_tag', recordId: picked.taskId, tagId: own });
  return { world, picked, own, secret };
}

describe.skipIf(serverUrl === undefined)(
  'MP-4-11 isolation: another person’s agent under a live delegation',
  () => {
    let world: AgentWorld;
    let picked: { readonly taskId: string; readonly credential: string };
    let own: string;
    let secret: string;

    beforeAll(async () => {
      ({ world, picked, own, secret } = await agentWithTags());
    }, 180_000);

    afterAll(async () => {
      await world?.drop();
    });

    it('reads its own task’s tags, reaches no tag command, and never sees the vocabulary', async () => {
      const read = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
        picked.credential,
      );
      const tags = (detailOf(read)['task'] as { tags: { name: string }[] }).tags;
      expect(tags.map((tag) => tag.name)).toStrictEqual(['On its task']);
      expect(JSON.stringify(read)).not.toContain(CANARY);
      for (const body of [
        { command: 'tag.list' },
        { command: 'tag.create', name: 'agent made' },
        { command: 'task.add_tag', recordId: picked.taskId, tagId: secret },
        { command: 'task.remove_tag', recordId: picked.taskId, tagId: own },
      ]) {
        // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
        const answer = await world.asAgent(
          { ...body, operationId: randomUUID() },
          picked.credential,
        );
        expect(codeOf(answer), body.command).not.toBe('not-a-refusal');
        expect(JSON.stringify(answer)).not.toContain(CANARY);
      }
      const rows = await world.db.admin.execute<{ readonly tag_id: string }>(
        `select tag_id from public.task_tags where task_id = $1`,
        [picked.taskId],
      );
      expect(rows.map((row) => row.tag_id)).toStrictEqual([own]);
      const made = await world.db.admin.execute(
        `select 1 from public.tags where business_id = $1 and name = 'agent made'`,
        [world.business],
      );
      expect(made).toHaveLength(0);
    });
  },
);
