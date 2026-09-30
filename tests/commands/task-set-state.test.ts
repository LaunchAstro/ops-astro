// SPDX-License-Identifier: AGPL-3.0-only
//
// The status select's Waiting on client and On hold (Stage 1 adds). The
// lifecycle three pick a state by machine category (specification 14.5), and
// Waiting on client shares `started` with Active, so `task.set_state` takes the
// id of one of the business's own states under `task:write`. Completion stays
// `task.complete`; leaving it stays `task.reopen`. The world is the ad hoc one.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from './fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { readTaskSpine } from '../../packages/core-commands/src/commands/context.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import type { Member } from './fixture.ts';
import {
  CANARY,
  alpha,
  as,
  bravo,
  bravoWriter,
  clientAWriter,
  db,
  fresh,
  outcomeOf,
  reader,
  serverUrl,
  setUp,
  tearDown,
  writer,
} from './adhoc-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-set-state: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Task = { recordId: string; revision: number };

/** The business's own state ids, by key. */
let alphaStates: Readonly<Record<string, string>>;
let bravoStates: Readonly<Record<string, string>>;

const statesOf = async (business: BusinessId): Promise<Readonly<Record<string, string>>> =>
  await db.app.withBusiness(business, async (tx) =>
    Object.fromEntries((await readTaskSpine(tx)).states.map((state) => [state.key, state.id])),
  );

const stored = async (recordId: string): Promise<{ state: string | null; revision: number }> => {
  const rows = await db.admin.execute<{ readonly state: string | null; readonly revision: string }>(
    `select data ->> 'state' as state, revision::text as revision from public.records where id = $1`,
    [recordId],
  );
  return { state: rows[0]?.state ?? null, revision: Number(rows[0]?.revision) };
};

const setState = async (
  business: BusinessId,
  by: Member,
  task: Task,
  stateId: unknown,
  operationId: string = randomUUID(),
) =>
  await as(business, by, {
    command: 'task.set_state',
    operationId,
    recordId: task.recordId,
    expectedRevision: task.revision,
    stateId,
  });

/** The task as the next write names it. */
const current = async (task: Task): Promise<Task> => ({
  recordId: task.recordId,
  revision: (await stored(task.recordId)).revision,
});

beforeAll(async () => {
  if (serverUrl === undefined) return;
  await setUp();
  alphaStates = await statesOf(alpha);
  bravoStates = await statesOf(bravo);
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

describe.skipIf(serverUrl === undefined)('Stage 1 adds: task.set_state', () => {
  it('is declared as a task write, authorised on the record, never an agent’s', () => {
    const declared = COMMAND_SURFACE.find((each) => String(each.name) === 'task.set_state');
    expect([
      declared?.kind,
      declared?.collection,
      declared?.action,
      declared?.authorisedOn,
      declared?.agent,
    ]).toStrictEqual(['write', 'task', 'write', 'record', 'never']);
  });

  it('sets Waiting on client, then On hold, then Active, and the read shows each', async () => {
    const task = await fresh(alpha, writer, 'status select');
    const setAndRead = async (key: string): Promise<void> => {
      const answer = await setState(alpha, writer, await current(task), alphaStates[key]);
      expect(outcomeOf(answer), key).toStrictEqual({ applied: true });
      expect(isCommandRefusal(answer) ? null : answer.detail).toMatchObject({ state: key });
      expect((await stored(task.recordId)).state).toBe(alphaStates[key]);
      const read = await executeRead(db.app, alpha, writer.presented, {
        read: 'task.read',
        recordId: task.recordId,
      });
      expect(isCommandRefusal(read) || !('task' in read) ? null : read.task.state?.key).toBe(key);
    };
    await setAndRead('waiting_on_client');
    await setAndRead('on_hold');
    await setAndRead('active');
    await setAndRead('needs_review');
  });

  it('owns the field beside the lifecycle three: task.update names all four', async () => {
    const task = await fresh(alpha, writer, 'generic');
    const answer = await as(alpha, writer, {
      command: 'task.update',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { state: alphaStates['on_hold'] },
    });
    expect(outcomeOf(answer)).toStrictEqual({
      code: 'TRANSITION_PROTECTED',
      names: ['state=task.complete task.reopen task.set_state task.start'],
    });
  });
});

describe.skipIf(serverUrl === undefined)('Stage 1 adds: task.set_state audit', () => {
  it('writes the change and the refusal to the audit chain as task.set_state', async () => {
    const task = await fresh(alpha, writer, 'audited');
    const [applied, refusal] = [randomUUID(), randomUUID()];
    await setState(alpha, writer, task, alphaStates['waiting_on_client'], applied);
    await setState(alpha, reader, await current(task), alphaStates['on_hold'], refusal);
    const events = await db.admin.execute<{
      readonly actor_id: string;
      readonly outcome: string;
      readonly refusal_code: string | null;
      readonly subject_record_id: string | null;
    }>(
      `select actor_id, outcome, refusal_code, subject_record_id from public.audit_events
        where business_id = $1 and command = 'task.set_state' and operation_id = any($2::text[])
        order by seq`,
      [alpha, [applied, refusal]],
    );
    // `toEqual`: the driver's rows are not plain objects.
    expect(events).toEqual([
      {
        actor_id: writer.actorId,
        outcome: 'applied',
        refusal_code: null,
        subject_record_id: task.recordId,
      },
      {
        actor_id: reader.actorId,
        outcome: 'refused',
        refusal_code: 'SCOPE_NOT_GRANTED',
        subject_record_id: null,
      },
    ]);
    expect((await stored(task.recordId)).state).toBe(alphaStates['waiting_on_client']);
  });
});

describe.skipIf(serverUrl === undefined)('Stage 1 adds: task.set_state refusals', () => {
  it('refuses a caller without task:write and writes nothing', async () => {
    const task = await fresh(alpha, writer, 'read only');
    const before = await stored(task.recordId);
    const answer = await setState(alpha, reader, task, alphaStates['on_hold']);
    expect(outcomeOf(answer)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    expect(await stored(task.recordId)).toStrictEqual(before);
    expect(JSON.stringify(answer)).not.toContain(task.recordId);
  });

  it('refuses a completed target: completion is task.complete’s', async () => {
    const task = await fresh(alpha, writer, 'not this way');
    const before = await stored(task.recordId);
    const answer = await setState(alpha, writer, task, alphaStates['complete']);
    expect(outcomeOf(answer)).toStrictEqual({
      code: 'TRANSITION_NOT_PERMITTED',
      names: ['complete'],
    });
    expect(isCommandRefusal(answer) ? answer.fixes.join(' ') : '').toContain('task.complete');
    expect(await stored(task.recordId)).toStrictEqual(before);
  });

  it('refuses a completed task: leaving completion is task.reopen’s, with a reason', async () => {
    const task = await fresh(alpha, writer, 'done');
    const done = await as(alpha, writer, {
      command: 'task.complete',
      recordId: task.recordId,
      expectedRevision: task.revision,
    });
    expect(outcomeOf(done)).toStrictEqual({ applied: true });
    const before = await stored(task.recordId);
    const answer = await setState(alpha, writer, await current(task), alphaStates['on_hold']);
    expect(outcomeOf(answer)).toStrictEqual({
      code: 'TRANSITION_NOT_PERMITTED',
      names: ['complete'],
    });
    expect(isCommandRefusal(answer) ? answer.fixes.join(' ') : '').toContain('task.reopen');
    expect(await stored(task.recordId)).toStrictEqual(before);
  });
});

describe.skipIf(serverUrl === undefined)('Stage 1 adds: task.set_state refusals', () => {
  it('refuses the state the task is already in', async () => {
    const task = await fresh(alpha, writer, 'same');
    await setState(alpha, writer, task, alphaStates['on_hold']);
    const answer = await setState(alpha, writer, await current(task), alphaStates['on_hold']);
    expect(outcomeOf(answer)).toStrictEqual({
      code: 'TRANSITION_NOT_PERMITTED',
      names: ['on_hold'],
    });
  });

  it('answers another business’s state id as it answers a fabricated one', async () => {
    const task = await fresh(alpha, writer, 'foreign state');
    const before = await stored(task.recordId);
    const foreign = await setState(alpha, writer, task, bravoStates['waiting_on_client']);
    const fabricated = await setState(alpha, writer, task, randomUUID());
    expect(outcomeOf(foreign)).toStrictEqual({ code: 'NOT_FOUND', names: ['stateId'] });
    expect(outcomeOf(fabricated)).toStrictEqual(outcomeOf(foreign));
    expect(JSON.stringify(foreign)).not.toContain(String(bravoStates['waiting_on_client']));
    expect(await stored(task.recordId)).toStrictEqual(before);
  });

  // A string that is no uuid names nothing, and is answered as every such
  // identifier is (root ruling 2); a value that is no string is mistyped.
  it.each([
    ['a key, not an id', 'on_hold', { code: 'NOT_FOUND', names: [] }],
    ['a number', 7, { code: 'FIELD_VALUE_INVALID', names: ['stateId'] }],
    ['null', null, { code: 'FIELD_VALUE_INVALID', names: ['stateId'] }],
    ['nothing', undefined, { code: 'FIELD_VALUE_INVALID', names: ['stateId'] }],
  ])('refuses %s as the state and writes nothing', async (_label, value, refusal) => {
    const task = await fresh(alpha, writer, 'hostile');
    const before = await stored(task.recordId);
    const answer = await setState(alpha, writer, task, value);
    expect(outcomeOf(answer)).toStrictEqual(refusal);
    expect(await stored(task.recordId)).toStrictEqual(before);
  });
});

describe.skipIf(serverUrl === undefined)('Stage 1 adds: task.set_state races', () => {
  it('two writers at one revision: one applies, the other is refused stale', async () => {
    const task = await fresh(alpha, writer, 'raced');
    const [first, second] = await Promise.all([
      setState(alpha, writer, task, alphaStates['waiting_on_client']),
      setState(alpha, writer, task, alphaStates['on_hold']),
    ]);
    const outcomes = [outcomeOf(first), outcomeOf(second)].map((each) =>
      'code' in each ? each['code'] : 'applied',
    );
    expect(outcomes.toSorted()).toStrictEqual(['VERSION_STALE', 'applied']);
    const won = isCommandRefusal(first) ? 'on_hold' : 'waiting_on_client';
    expect(await stored(task.recordId)).toStrictEqual({
      state: alphaStates[won],
      revision: task.revision + 1,
    });
  });
});

describe.skipIf(serverUrl === undefined)('Stage 1 adds: task.set_state isolation', () => {
  it('another business: its task is not found and keeps its state', async () => {
    const foreign = await fresh(bravo, bravoWriter, CANARY);
    const before = await stored(foreign.recordId);
    const answer = await setState(alpha, writer, foreign, alphaStates['on_hold']);
    expect(outcomeOf(answer)).toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(answer)).not.toContain(CANARY);
    expect(await stored(foreign.recordId)).toStrictEqual(before);
    // Its own writer, with its own business's ids, is served.
    const own = await setState(bravo, bravoWriter, foreign, bravoStates['on_hold']);
    expect(outcomeOf(own)).toStrictEqual({ applied: true });
  });

  it('another client in the same business: a writer on client A’s task cannot set client B’s', async () => {
    const taskA = await fresh(alpha, writer, 'client A');
    const taskB = await fresh(alpha, writer, CANARY);
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, clientAWriter, 'write', { kind: 'record', id: taskA.recordId });
    });
    const own = await setState(alpha, clientAWriter, taskA, alphaStates['waiting_on_client']);
    expect(outcomeOf(own)).toStrictEqual({ applied: true });
    const before = await stored(taskB.recordId);
    const refused = await setState(alpha, clientAWriter, taskB, alphaStates['waiting_on_client']);
    expect(outcomeOf(refused)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    expect(JSON.stringify(refused)).not.toContain(CANARY);
    expect(await stored(taskB.recordId)).toStrictEqual(before);
  });
});
