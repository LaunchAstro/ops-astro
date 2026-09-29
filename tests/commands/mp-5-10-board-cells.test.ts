// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-10: the Projects board's in-place cell editors, against a real
// database, through the commands they call. The assignee is `task.assign`
// under `task:assign`; the due date is `task.update` and the stage
// `task.set_stage`, both under `task:write`. Each change is read back with
// its audit event; each is refused, with nothing written, to a person
// without its key (`MP-5-10 refusals per key`); and no editor reaches
// another client's task, another business's, or a task outside an agent's
// live delegation (`MP-5-10 isolation`). The estimate waits on MP-4-8's field.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { agentWorld, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'mp-5-10-board-cells: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Body = Readonly<Record<string, unknown>>;
type Edit = 'task.assign' | 'task.update' | 'task.set_stage';

const CANARY = `canary-${randomUUID()}`;

let world: AgentWorld;
let editor: Decider;
let writerOnly: Member;
let reader: Member;
let pairEditor: Member;
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

// The stage as stored (txt_5, `task.set_stage`'s slot). `task.read` answers
// it only with SL08's U15 (MP-4-2), not on main, so it is read here directly.
const stageOf = async (name: string): Promise<string | null> =>
  (
    await world.db.admin.execute<{ readonly stage: string | null }>(
      `select txt_5 as stage from public.records where id = $1`,
      [ids[name] ?? ''],
    )
  )[0]?.stage ?? null;

const readTask = async (name: string): Promise<Body> => {
  const answer = await executeRead(world.db.app, world.business, editor.presented, {
    read: 'task.read',
    recordId: ids[name] ?? '',
  });
  if (isCommandRefusal(answer)) throw new Error(`task.read refused ${answer.code}`);
  return (answer as unknown as { readonly task: Body }).task;
};

const edit = async (who: Member | null, command: Edit, name: string, fields: Body) => {
  const operationId = randomUUID();
  const body = {
    command,
    operationId,
    recordId: ids[name] ?? '',
    expectedRevision: await revisionOf(ids[name] ?? ''),
    fields,
  };
  const result = who === null ? await world.asAgent(body) : await world.asPerson(who, body);
  return { result, operationId };
};

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await agentWorld('b10', `mp510-${randomUUID().slice(0, 8)}`);
  editor = await world.decider('editor');
  writerOnly = await enrol(world.db.app, world.business, 'writer-only');
  reader = await enrol(world.db.app, world.business, 'reader');
  pairEditor = await enrol(world.db.app, world.business, 'pair-editor');
  for (const [name, title] of [
    ['cells', 'edited in place'],
    ['own', 'the pair editor’s'],
    ['theirs', CANARY],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- one task after another, each named
    const made = await world.asPerson(editor, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title },
    });
    if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
    ids[name] = made.recordId ?? '';
  }
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, editor, 'assign');
    await grantTo(tx, writerOnly, 'read');
    await grantTo(tx, writerOnly, 'write');
    await grantTo(tx, reader, 'read');
    await grantTo(tx, pairEditor, 'read', { kind: 'record', id: ids['own'] ?? '' });
    await grantTo(tx, pairEditor, 'write', { kind: 'record', id: ids['own'] ?? '' });
  });
  bravo = (await insertBusiness(
    world.db.app,
    `mp510-bravo-${randomUUID().slice(0, 8)}`,
  )) as BusinessId;
  await installSpine(world.db.app, bravo);
  bravoOwner = await enrol(world.db.app, bravo, 'bravo-owner');
  await world.db.app.withBusiness(bravo, async (tx) => {
    for (const action of ['read', 'write', 'assign'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, bravoOwner, action);
    }
  });
}, 240_000);

afterAll(async () => {
  await world?.drop();
});

describe.skipIf(serverUrl === undefined)('MP-5-10 each change is recorded and read back', () => {
  it('assignee, due and stage each save through their command, with their audit event', async () => {
    const assigned = await edit(editor, 'task.assign', 'cells', { assignee: editor.personId });
    const dated = await edit(editor, 'task.update', 'cells', { due: '2026-10-02T00:00:00.000Z' });
    const staged = await edit(editor, 'task.set_stage', 'cells', { stage: 'Drafting' });
    expect([assigned, dated, staged].map((each) => isCommandRefusal(each.result))).toStrictEqual([
      false,
      false,
      false,
    ]);
    const task = await readTask('cells');
    expect((task['assignee'] as Body | null)?.['personId']).toBe(editor.personId);
    expect(String(task['due'])).toContain('2026-10-02');
    expect(await stageOf('cells')).toBe('Drafting');
    for (const each of [assigned, dated, staged]) {
      // eslint-disable-next-line no-await-in-loop -- each change's own audit event, in turn
      expect(await world.auditFor(each.operationId)).toStrictEqual([
        { outcome: 'applied', code: null },
      ]);
    }
  });
});

describe.skipIf(serverUrl === undefined)('MP-5-10 refusals per key', () => {
  it('task:assign: a writer without it is refused the assignee, and nothing is written', async () => {
    const before = await revisionOf(ids['cells'] ?? '');
    const { result } = await edit(writerOnly, 'task.assign', 'cells', {
      assignee: writerOnly.personId,
    });
    expect(isCommandRefusal(result)).toBe(true);
    expect(await revisionOf(ids['cells'] ?? '')).toBe(before);
  });

  it('task:write: a reader is refused due and stage, and nothing is written', async () => {
    const before = await revisionOf(ids['cells'] ?? '');
    const due = await edit(reader, 'task.update', 'cells', { due: '2026-12-01T00:00:00.000Z' });
    const stage = await edit(reader, 'task.set_stage', 'cells', { stage: 'Refused' });
    expect([isCommandRefusal(due.result), isCommandRefusal(stage.result)]).toStrictEqual([
      true,
      true,
    ]);
    expect(await revisionOf(ids['cells'] ?? '')).toBe(before);
    expect(await stageOf('cells')).toBe('Drafting');
  });

  // task:write on the time estimate waits on MP-4-8's estimated_minutes field
  // (SL08 U20, LEANS-ON). No todo here: the isolation manifest refuses a skip.
});

describe.skipIf(serverUrl === undefined)('MP-5-10 isolation', () => {
  it('another client in the same business: a record-scoped editor edits its own task and no other', async () => {
    expect(
      isCommandRefusal((await edit(pairEditor, 'task.set_stage', 'own', { stage: 'Mine' })).result),
    ).toBe(false);
    const crossing = (await edit(pairEditor, 'task.set_stage', 'theirs', { stage: 'Taken' }))
      .result;
    expect(isCommandRefusal(crossing)).toBe(true);
    expect(JSON.stringify(crossing)).not.toContain(CANARY);
    expect(await stageOf('theirs')).toBeNull();
  });

  it('another business: its editor is refused alpha’s task, shown no canary', async () => {
    const crossing = (
      await edit(bravoOwner, 'task.assign', 'theirs', { assignee: bravoOwner.personId })
    ).result;
    expect(isCommandRefusal(crossing)).toBe(true);
    expect(JSON.stringify(crossing)).not.toContain(CANARY);
    expect((await readTask('theirs'))['assignee']).toBeNull();
  });

  it('another person under a live delegation: the agent is refused a task outside it', async () => {
    await world.pickUp(editor, 'the agent’s own task');
    const { result } = await edit(null, 'task.update', 'theirs', {
      due: '2026-11-01T00:00:00.000Z',
    });
    expect(isCommandRefusal(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect((await readTask('theirs'))['due']).toBeNull();
  });
});
