// SPDX-License-Identifier: AGPL-3.0-only
//
// #1245: the internal comment's mention picker offered every person in the
// business (`person.list`), so it offered staff who cannot read the task and
// whose mention the server then refuses. `task.mentionable` is the picker's
// list: the business's staff who can read this task, and only to a caller
// who reads the task and may read the people directory (`person:read`, what
// `person.list` asks), so it never names anyone `person.list` would not.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { grantTo, WHOLE_BUSINESS, type Member } from './fixture.ts';
import {
  alpha,
  as,
  bravo,
  clientA,
  clientB,
  db,
  outcomeOf,
  owner,
  person,
  revisionOf,
  setUp,
  taskFor,
  tearDown,
} from './duplicate-world.ts';

beforeAll(async () => {
  await setUp();
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, owner, 'read', WHOLE_BUSINESS, false, 'person');
  });
}, 180_000);
afterAll(tearDown);

const mentionable = async (caller: Member, recordId: string) =>
  (await executeRead(db.app, alpha, caller.presented, {
    read: 'task.mentionable',
    recordId,
  })) as Readonly<Record<string, unknown>>;

const offered = (answer: Readonly<Record<string, unknown>>): readonly string[] =>
  ((answer['persons'] ?? []) as readonly { readonly personId: string }[]).map(
    (row) => row.personId,
  );

const mention = async (author: Member, task: string, ids: readonly string[]) =>
  outcomeOf(
    await as(alpha, author, {
      command: 'task.comment',
      recordId: task,
      expectedRevision: await revisionOf(task),
      body: 'note',
      audience: 'internal',
      mentions: ids,
    }),
  );

it('offers the staff who can read the task, and the server accepts each one', async () => {
  const task = await taskFor(alpha, owner, 'mention picker task', clientA);
  const onTask = await person('on-task');
  const onClient = await person('on-client-a');
  const onOther = await person('on-client-b');
  const blind = await person('no-grant');
  const foreign = await person('bravo-staff', bravo);
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, onTask, 'read', { kind: 'record', id: task });
    await grantTo(tx, onClient, 'read', { kind: 'party', id: clientA });
    await grantTo(tx, onOther, 'read', { kind: 'party', id: clientB });
  });
  // The picker's old source: the whole business, the person who cannot read included.
  const directory = await executeRead(db.app, alpha, owner.presented, { read: 'person.list' });
  expect(JSON.stringify(directory)).toContain(blind.personId);

  const answer = await mentionable(owner, task);
  const ids = offered(answer);
  expect(ids).toEqual(expect.arrayContaining([owner.personId, onTask.personId, onClient.personId]));
  for (const never of [blind, onOther, foreign]) expect(ids).not.toContain(never.personId);

  const others = ids.filter((id) => id !== owner.personId);
  expect(await mention(owner, task, others), 'every offered person can be mentioned').toMatchObject(
    { ok: true },
  );
  expect(await mention(owner, task, [blind.personId])).toMatchObject({
    code: 'MENTION_NOT_READABLE',
  });
});

it('answers a caller who cannot read the task as not found, naming nobody', async () => {
  const task = await taskFor(alpha, owner, 'unread task', clientA);
  const outsider = await person('reads-client-b');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, outsider, 'read', { kind: 'party', id: clientB });
    await grantTo(tx, outsider, 'read', WHOLE_BUSINESS, false, 'person');
  });
  const answer = await mentionable(outsider, task);
  expect(answer['code']).toBe('NOT_FOUND');
  expect(JSON.stringify(answer)).not.toContain(owner.personId);
});

it('names nobody to a task reader refused the people directory, as person.list refuses them', async () => {
  const task = await taskFor(alpha, owner, 'directory task', clientA);
  const reader = await person('task-reader-no-directory');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, reader, 'read', { kind: 'record', id: task });
  });
  const directory = await executeRead(db.app, alpha, reader.presented, { read: 'person.list' });
  expect(directory).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  const answer = await mentionable(reader, task);
  expect(offered(answer)).toStrictEqual([]);
  expect(JSON.stringify(answer)).not.toContain(owner.personId);
});
