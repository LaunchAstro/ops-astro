// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-11's command step (CS-4.19 to CS-4.21): the business's tag vocabulary
// (`tag.create`, `tag.list`) and a task's tags (`task.add_tag`,
// `task.remove_tag`, the `tags` of `task.read`), through the envelope and the
// read path against a real database. The crossings are in
// `task-tags-isolation.test.ts`.
//
// `tag.create` is `tag:write` on the business; adding and removing are
// `task:write` on the task; the vocabulary is `task:read` on the business.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { grantTo, type Member } from './fixture.ts';
import { codeOf } from './agent-fixture.ts';
import { WHOLE, outcomeOf, timeWorld, type TimeWorld } from './time-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task-tags: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

let w: TimeWorld;
const live = describe.skipIf(serverUrl === undefined);

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('tg');
  // Ada and Noah name tags; the task-only member reads and writes tasks and
  // holds no `tag:write`; the client-A member is given one task's grants by
  // the test that needs them.
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, w.ada, 'write', WHOLE, false, 'tag');
    await grantTo(tx, w.noah, 'write', WHOLE, false, 'tag');
  });
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

const run = async (member: Member, body: Record<string, unknown>) =>
  await w.as(w.alpha, member, body);

const tagIdOf = (answer: CommandResult): string => {
  if (isCommandRefusal(answer)) throw new Error(`refused ${answer.code}`);
  return String((answer.detail as { tagId?: unknown }).tagId);
};

async function vocabulary(member: Member): Promise<string[]> {
  const read = await executeRead(w.db.app, w.alpha, member.presented, {
    read: 'tag.list',
  } as never);
  if (isCommandRefusal(read)) throw new Error(`tag.list refused ${read.code}`);
  return (read as unknown as { tags: { id: string; name: string }[] }).tags.map((tag) => tag.name);
}

async function tagsOn(member: Member, taskId: string) {
  const read = await executeRead(w.db.app, w.alpha, member.presented, {
    read: 'task.read',
    recordId: taskId,
  });
  if (isCommandRefusal(read) || !('task' in read)) throw new Error('task.read refused');
  return (read.task as unknown as { tags: { name: string }[] }).tags.map((tag) => tag.name);
}

const row = (name: string) => {
  const found = COMMAND_SURFACE.find((each) => each.name === name);
  return [found?.kind, found?.collection, found?.action, found?.authorisedOn, found?.agent];
};

describe('MP-4-11 tag commands are declared', () => {
  it('tag.create is tag:write on the business; adding and removing are task:write on the task', () => {
    expect(row('tag.create')).toStrictEqual(['write', 'tag', 'write', 'business', 'never']);
    expect(row('task.add_tag')).toStrictEqual(['write', 'task', 'write', 'record', 'never']);
    expect(row('task.remove_tag')).toStrictEqual(['write', 'task', 'write', 'record', 'never']);
    expect(row('tag.list')).toStrictEqual(['read', 'task', 'read', 'business', 'never']);
  });
});

live('MP-4-11 tags through the commands', () => {
  it('CS-4.20 add an existing tag, or create a new one from the new-tag row', async () => {
    const task = await w.fresh(w.alpha, w.ada, 'tagged');
    const made = await run(w.ada, { command: 'tag.create', name: 'Launch' });
    const launch = tagIdOf(made);
    expect(
      outcomeOf(await run(w.ada, { command: 'task.add_tag', recordId: task, tagId: launch })),
    ).toStrictEqual({ applied: true });
    expect(await tagsOn(w.ada, task)).toStrictEqual(['Launch']);
    // Noah adds the tag Ada made: the vocabulary is the business's.
    const other = await w.fresh(w.alpha, w.noah, 'also tagged');
    await run(w.noah, { command: 'task.add_tag', recordId: other, tagId: launch });
    expect(await tagsOn(w.noah, other)).toStrictEqual(['Launch']);
  });
});

live('MP-4-11 tags through the commands', () => {
  it('CS-4.21 remove the tag from this task, and only from this task', async () => {
    const one = await w.fresh(w.alpha, w.ada, 'one');
    const two = await w.fresh(w.alpha, w.ada, 'two');
    const tag = tagIdOf(await run(w.ada, { command: 'tag.create', name: 'Removable' }));
    await run(w.ada, { command: 'task.add_tag', recordId: one, tagId: tag });
    await run(w.ada, { command: 'task.add_tag', recordId: two, tagId: tag });
    const removed = await run(w.ada, { command: 'task.remove_tag', recordId: one, tagId: tag });
    expect(outcomeOf(removed)).toStrictEqual({ applied: true });
    expect(await tagsOn(w.ada, one)).toStrictEqual([]);
    expect(await tagsOn(w.ada, two)).toStrictEqual(['Removable']);
    // The vocabulary keeps it; removing it again finds nothing to remove.
    expect(await vocabulary(w.ada)).toContain('Removable');
    const again = await run(w.ada, { command: 'task.remove_tag', recordId: one, tagId: tag });
    expect(outcomeOf(again)).toStrictEqual({ code: 'NOT_FOUND', names: ['tagId'] });
  });
});

live('MP-4-11 tags through the commands', () => {
  it('case-insensitive duplicates refused', async () => {
    tagIdOf(await run(w.ada, { command: 'tag.create', name: 'Urgent' }));
    for (const name of ['urgent', 'URGENT', '  Urgent  ', 'uRgEnT']) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const answer = await run(w.noah, { command: 'tag.create', name });
      expect(outcomeOf(answer), name).toStrictEqual({
        code: 'UNIQUE_VALUE_TAKEN',
        names: ['name'],
      });
    }
    expect(
      (await vocabulary(w.ada)).filter((name) => name.toLowerCase() === 'urgent'),
    ).toStrictEqual(['Urgent']);
    // A task takes a tag once.
    const task = await w.fresh(w.alpha, w.ada, 'once');
    const [tag] = await w.db.admin.execute<{ id: string }>(
      `select id from public.tags where business_id = $1 and name = 'Urgent'`,
      [w.alpha],
    );
    await run(w.ada, { command: 'task.add_tag', recordId: task, tagId: tag?.id });
    const twice = await run(w.ada, { command: 'task.add_tag', recordId: task, tagId: tag?.id });
    expect(outcomeOf(twice)).toStrictEqual({ code: 'UNIQUE_VALUE_TAKEN', names: ['tagId'] });
    expect(await tagsOn(w.ada, task)).toStrictEqual(['Urgent']);
  });
});

live('MP-4-11 tags through the commands', () => {
  it('two creates of one name at once leave one tag', async () => {
    const answers = await Promise.all(
      ['Racing', 'racing'].map(async (name) => await run(w.ada, { command: 'tag.create', name })),
    );
    expect(answers.map((answer) => codeOf(answer)).toSorted()).toStrictEqual([
      'UNIQUE_VALUE_TAKEN',
      'not-a-refusal',
    ]);
    const rows = await w.db.admin.execute(
      `select 1 from public.tags where business_id = $1 and lower(name) = 'racing'`,
      [w.alpha],
    );
    expect(rows).toHaveLength(1);
  });
});

live('MP-4-11 tags through the commands', () => {
  it('CS-4.19 the vocabulary is the business’s tags, by name', async () => {
    tagIdOf(await run(w.ada, { command: 'tag.create', name: 'Zebra' }));
    tagIdOf(await run(w.ada, { command: 'tag.create', name: 'aardvark' }));
    const names = await vocabulary(w.noah);
    expect(names).toEqual(expect.arrayContaining(['Zebra', 'aardvark']));
    expect(names).toStrictEqual(names.toSorted((a, b) => a.localeCompare(b, 'en')));
  });
});

live('MP-4-11 tags through the commands', () => {
  it('a tag name is trimmed text of 1 to 40 characters, never a control character', async () => {
    for (const name of ['', '   ', 'x'.repeat(41), 7, null, ['a'], 'tab\there', 'nul\u0000']) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const answer = await run(w.ada, { command: 'tag.create', name });
      expect(['FIELD_VALUE_INVALID', 'COMMAND_BODY_INVALID'], JSON.stringify(name)).toContain(
        codeOf(answer),
      );
    }
    const kept = await run(w.ada, { command: 'tag.create', name: '  Spaced out  ' });
    expect(await vocabulary(w.ada)).toContain('Spaced out');
    expect(codeOf(kept)).toBe('not-a-refusal');
  });
});

live('MP-4-11 tags through the commands', () => {
  it('hostile operands are refused, never a fault', async () => {
    const task = await w.fresh(w.alpha, w.ada, 'hostile');
    for (const body of [
      { command: 'task.add_tag', recordId: task, tagId: 'not-a-tag' },
      { command: 'task.add_tag', recordId: task, tagId: randomUUID() },
      { command: 'task.add_tag', recordId: 'not-a-task', tagId: randomUUID() },
      { command: 'task.remove_tag', recordId: task, tagId: 5 },
      { command: 'task.remove_tag', recordId: task },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const answer = await run(w.ada, body);
      expect(['NOT_FOUND', 'COMMAND_BODY_INVALID'], JSON.stringify(body)).toContain(codeOf(answer));
    }
    expect(await tagsOn(w.ada, task)).toStrictEqual([]);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-11 refusals, one per key', () => {
  it('tag:write refused: a task writer without it makes no tag', async () => {
    const answer = await run(w.taskOnly, { command: 'tag.create', name: 'Not mine to make' });
    expect(outcomeOf(answer)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    expect(await vocabulary(w.ada)).not.toContain('Not mine to make');
  });

  it('task:write refused: a reader of the task neither adds nor removes a tag', async () => {
    const task = await w.fresh(w.alpha, w.ada, 'read only here');
    const tag = tagIdOf(await run(w.ada, { command: 'tag.create', name: 'Kept' }));
    await run(w.ada, { command: 'task.add_tag', recordId: task, tagId: tag });
    const other = tagIdOf(await run(w.ada, { command: 'tag.create', name: 'Never added' }));
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, w.clientA, 'read', { kind: 'record', id: task });
    });
    for (const body of [
      { command: 'task.add_tag', recordId: task, tagId: other },
      { command: 'task.remove_tag', recordId: task, tagId: tag },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const answer = await run(w.clientA, body);
      expect(outcomeOf(answer), body.command).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    }
    expect(await tagsOn(w.ada, task)).toStrictEqual(['Kept']);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-11 audit read-back', () => {
  it('each change and each refusal joins the audit chain by its own name, with its change', async () => {
    const task = await w.fresh(w.alpha, w.ada, 'audited');
    const ops: Record<string, string> = {};
    const step = async (label: string, member: Member, body: Record<string, unknown>) => {
      ops[label] = randomUUID();
      return await run(member, { ...body, operationId: ops[label] });
    };
    const tag = tagIdOf(await step('create', w.ada, { command: 'tag.create', name: 'Audited' }));
    await step('create again', w.noah, { command: 'tag.create', name: 'audited' });
    await step('add', w.ada, { command: 'task.add_tag', recordId: task, tagId: tag });
    await step('remove', w.noah, { command: 'task.remove_tag', recordId: task, tagId: tag });
    const events = await w.db.admin.execute<{
      readonly operation_id: string;
      readonly command: string;
      readonly actor_id: string;
      readonly outcome: string;
      readonly refusal_code: string | null;
    }>(
      `select operation_id, command, actor_id, outcome, refusal_code from public.audit_events
        where business_id = $1 and operation_id = any($2::text[]) order by seq`,
      [w.alpha, Object.values(ops)],
    );
    const label = Object.fromEntries(Object.entries(ops).map(([key, value]) => [value, key]));
    // `toEqual`: the driver's rows are not plain objects.
    expect(
      events.map((event) => [
        label[event.operation_id],
        event.command,
        event.actor_id === w.ada.actorId ? 'ada' : 'noah',
        event.outcome,
        event.refusal_code,
      ]),
    ).toEqual([
      ['create', 'tag.create', 'ada', 'applied', null],
      ['create again', 'tag.create', 'noah', 'refused', 'UNIQUE_VALUE_TAKEN'],
      ['add', 'task.add_tag', 'ada', 'applied', null],
      ['remove', 'task.remove_tag', 'noah', 'applied', null],
    ]);
    // Each change committed with its event: the tag is there, off the task.
    expect(await vocabulary(w.ada)).toContain('Audited');
    expect(await tagsOn(w.ada, task)).toStrictEqual([]);
  });
});
