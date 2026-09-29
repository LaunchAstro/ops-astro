// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-9: what the Projects board's row does, against a real database,
// through the same commands its controls call. Rename in place is
// `task.update` on the title; the tick is the one completion transition,
// `task.complete` and `task.reopen`, never a second one; the hover box's
// add subtask is `task.create` with a parent. Each change is read back with
// its audit event, and each is refused, with nothing written, to a person
// without `task:write` (`MP-5-9 refusals per key`). The row never reaches
// another client's task, another business's, or a task outside an agent's
// live delegation (`MP-5-9 isolation`).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { agentWorld, codeOf, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'mp-5-9-board-row: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Body = Readonly<Record<string, unknown>>;

const CANARY = `canary-${randomUUID()}`;

let world: AgentWorld;
let writer: Decider;
let reader: Member;
let pairWriter: Member;
let bravo: BusinessId;
let bravoOwner: Member;
const ids: Record<string, string> = {};

const revisionOf = async (recordId: string): Promise<number> =>
  Number(
    (
      await world.db.admin.execute<{ readonly revision: string }>(
        `select revision::text as revision from public.records where id = $1`,
        [recordId],
      )
    )[0]?.revision,
  );

/** The task as `task.read` answers the writer. */
const readTask = async (name: string): Promise<Body> => {
  const answer = await executeRead(world.db.app, world.business, writer.presented, {
    read: 'task.read',
    recordId: ids[name] ?? '',
  });
  if (isCommandRefusal(answer)) throw new Error(`task.read refused ${answer.code}`);
  return (answer as unknown as { readonly task: Body }).task;
};

const rename = async (who: Member | null, name: string, title: string) => {
  const operationId = randomUUID();
  const body = {
    command: 'task.update',
    operationId,
    recordId: ids[name] ?? '',
    expectedRevision: await revisionOf(ids[name] ?? ''),
    fields: { title },
  };
  const result = who === null ? await world.asAgent(body) : await world.asPerson(who, body);
  return { result, operationId };
};

const tick = async (who: Member, name: string, command: 'task.complete' | 'task.reopen') => {
  const operationId = randomUUID();
  const result = await world.asPerson(who, {
    command,
    operationId,
    recordId: ids[name] ?? '',
    expectedRevision: await revisionOf(ids[name] ?? ''),
    ...(command === 'task.reopen' ? { reason: 'ticked again on the board' } : {}),
  });
  return { result, operationId };
};

const addSubtask = async (who: Member, parent: string, title: string) => {
  const operationId = randomUUID();
  const result = await world.asPerson(who, {
    command: 'task.create',
    operationId,
    parentId: ids[parent] ?? '',
    fields: { title },
  });
  return { result, operationId };
};

const titleOf = (task: Body): string => JSON.stringify(task['title']);

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await agentWorld('b9', `mp59-${randomUUID().slice(0, 8)}`);
  writer = await world.decider('writer');
  reader = await enrol(world.db.app, world.business, 'reader');
  pairWriter = await enrol(world.db.app, world.business, 'pair-writer');
  for (const [name, title] of [
    ['named', 'first name'],
    ['ticked', 'to tick'],
    ['parent', 'has steps'],
    ['own', 'the pair writer’s'],
    ['theirs', CANARY],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- one task after another, each named
    const made = await world.asPerson(writer, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title },
    });
    if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
    ids[name] = made.recordId ?? '';
  }
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, reader, 'read');
    await grantTo(tx, pairWriter, 'read', { kind: 'record', id: ids['own'] ?? '' });
    await grantTo(tx, pairWriter, 'write', { kind: 'record', id: ids['own'] ?? '' });
  });
  bravo = (await insertBusiness(
    world.db.app,
    `mp59-bravo-${randomUUID().slice(0, 8)}`,
  )) as BusinessId;
  await installSpine(world.db.app, bravo);
  bravoOwner = await enrol(world.db.app, bravo, 'bravo-owner');
  await world.db.app.withBusiness(bravo, async (tx) => {
    for (const action of ['read', 'write'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, bravoOwner, action);
    }
  });
}, 240_000);

afterAll(async () => {
  await world?.drop();
});

describe.skipIf(serverUrl === undefined)('MP-5-9 each change is recorded and read back', () => {
  it('rename in place: task.update writes the new title, with its audit event', async () => {
    const { result, operationId } = await rename(writer, 'named', 'renamed on the board');
    expect(isCommandRefusal(result)).toBe(false);
    expect(titleOf(await readTask('named'))).toContain('renamed on the board');
    expect(await world.auditFor(operationId)).toStrictEqual([{ outcome: 'applied', code: null }]);
  });

  it('the tick completes through the one completion transition, and reopen restores', async () => {
    const done = await tick(writer, 'ticked', 'task.complete');
    expect(isCommandRefusal(done.result)).toBe(false);
    expect((await readTask('ticked'))['completedAt']).not.toBeNull();
    const reopened = await tick(writer, 'ticked', 'task.reopen');
    expect(isCommandRefusal(reopened.result)).toBe(false);
    expect((await readTask('ticked'))['completedAt']).toBeNull();
    expect([
      ...(await world.auditFor(done.operationId)),
      ...(await world.auditFor(reopened.operationId)),
    ]).toStrictEqual([
      { outcome: 'applied', code: null },
      { outcome: 'applied', code: null },
    ]);
  });

  it('add subtask from the row: task.create under the parent, with its audit event', async () => {
    const { result, operationId } = await addSubtask(writer, 'parent', 'a step from the row');
    expect(isCommandRefusal(result)).toBe(false);
    // `uuid_4` is the parent slot (migration 0006).
    const parent = await world.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.records where uuid_4 = $1 and deleted_at is null`,
      [ids['parent']],
    );
    expect(parent[0]?.n).toBe('1');
    expect(await world.auditFor(operationId)).toStrictEqual([{ outcome: 'applied', code: null }]);
  });
});

describe.skipIf(serverUrl === undefined)('MP-5-9 refusals per key', () => {
  it('task:write: a reader is refused rename, tick and add subtask, and nothing is written', async () => {
    const before = await revisionOf(ids['ticked'] ?? '');
    const refused = [
      (await rename(reader, 'ticked', 'not allowed')).result,
      (await tick(reader, 'ticked', 'task.complete')).result,
      (await addSubtask(reader, 'ticked', 'not allowed')).result,
    ];
    expect(refused.map((each) => isCommandRefusal(each))).toStrictEqual([true, true, true]);
    expect(await revisionOf(ids['ticked'] ?? '')).toBe(before);
    expect(titleOf(await readTask('ticked'))).not.toContain('not allowed');
  });

  it.todo('time:write: the hover box’s timer (LEANS-ON the time.* commands, SL08 U19)');
});

describe.skipIf(serverUrl === undefined)('MP-5-9 isolation', () => {
  it('another client in the same business: a record-scoped writer renames its own task and no other', async () => {
    expect(isCommandRefusal((await rename(pairWriter, 'own', 'mine renamed')).result)).toBe(false);
    const crossing = (await rename(pairWriter, 'theirs', 'taken over')).result;
    expect(isCommandRefusal(crossing)).toBe(true);
    expect(JSON.stringify(crossing)).not.toContain(CANARY);
    expect(titleOf(await readTask('theirs'))).toContain(CANARY);
  });

  it('another business: its writer is refused alpha’s task, shown no canary', async () => {
    const body = {
      command: 'task.update',
      operationId: randomUUID(),
      recordId: ids['theirs'] ?? '',
      expectedRevision: await revisionOf(ids['theirs'] ?? ''),
      fields: { title: 'from bravo' },
    };
    const crossing = await world.asPerson({ ...bravoOwner }, body);
    expect(isCommandRefusal(crossing)).toBe(true);
    expect(JSON.stringify(crossing)).not.toContain(CANARY);
    expect(titleOf(await readTask('theirs'))).toContain(CANARY);
  });

  it('another person under a live delegation: the agent is refused a task outside it', async () => {
    await world.pickUp(writer, 'the agent’s own task');
    const { result } = await rename(null, 'theirs', 'agent rename');
    expect(codeOf(result)).not.toBe('ok');
    expect(isCommandRefusal(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(titleOf(await readTask('theirs'))).toContain(CANARY);
  });
});
