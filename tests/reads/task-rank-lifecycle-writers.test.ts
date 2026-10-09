// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readTaskSpine } from '../../packages/core-commands/src/commands/context.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { readAuditEvents } from '../../packages/core-commands/src/commands/audit.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  completeRankStep,
  reopenRankStep,
  assertRevokedRankReads,
} from './task-rank-lifecycle-support.ts';
import {
  appliedTask,
  dateRankTask,
  makeRankTask,
  rankCommand,
  rankCoreWorld,
  readRankBoard,
  readRankTask,
  type RankCoreWorld,
} from './task-rank-core-world.ts';

let world: RankCoreWorld;
beforeAll(async () => {
  world = await rankCoreWorld();
}, 180_000);
afterAll(async () => {
  await world?.db.drop();
});

async function stateId(key: string): Promise<string> {
  const states = await world.db.app.withBusiness(
    world.business,
    async (tx) => (await readTaskSpine(tx)).states,
  );
  const state = states.find((row) => row.key === key);
  if (state === undefined) throw new Error(`Installed state ${key} absent`);
  return state.id;
}

it.each(['active', 'waiting_on_client'])(
  'task.set_state first enters %s and persists one start date',
  async (key) => {
    const made = await makeRankTask(world);
    const first = appliedTask(
      await rankCommand(world, {
        command: 'task.set_state',
        recordId: made.id,
        expectedRevision: made.revision,
        stateId: await stateId(key),
      }),
    );
    const task = await readRankTask(world, made.id);
    expect(task.state).toMatchObject({ key, machineCategory: 'started' });
    expect(task.startedAt).toEqual(expect.any(String));
    expect(task.revision).toBe(first.revision);
    expect(
      (await readRankBoard(world)).tasks.find((row) => row.id === made.id)?.rank,
    ).toStrictEqual(task.rank);
  },
);

it('entering backlog without having started does not fabricate first-start evidence', async () => {
  const made = await makeRankTask(world);
  appliedTask(
    await rankCommand(world, {
      command: 'task.set_state',
      recordId: made.id,
      expectedRevision: made.revision,
      stateId: await stateId('on_hold'),
    }),
  );
  expect(await readRankTask(world, made.id)).toMatchObject({
    startedAt: null,
    state: { key: 'on_hold', machineCategory: 'backlog' },
    rank: { score: 504 },
  });
});

it('moving between started states, completion and reopen retain the original corrected first-start date', async () => {
  const made = await makeRankTask(world);
  await dateRankTask(world, made.id, 100);
  const dated = await readRankTask(world, made.id);
  const move = async (key: string) => {
    const before = await readRankTask(world, made.id);
    appliedTask(
      await rankCommand(world, {
        command: 'task.set_state',
        recordId: made.id,
        expectedRevision: before.revision,
        stateId: await stateId(key),
      }),
    );
    expect((await readRankTask(world, made.id)).startedAt).toBe(dated.startedAt);
  };
  await move('waiting_on_client');
  await move('on_hold');
  await move('active');
  const finished = await completeRankStep(world, made.id, dated.startedAt);
  await reopenRankStep(world, made.id, dated.startedAt, finished);
});

it('two actual connections replay one task.start operation with one date and one applied audit event', async () => {
  const made = await makeRankTask(world);
  const request = {
    command: 'task.start',
    operationId: randomUUID(),
    recordId: made.id,
    expectedRevision: made.revision,
  } as const;
  const second = connect(world.db.appUrl, { source: 'runtime' });
  try {
    const [first, replay] = await Promise.all([
      rankCommand(world, request),
      executeCommand(second, world.business, world.owner.presented, 'api', request),
    ]);
    expect(replay).toStrictEqual(first);
    expect(await readRankTask(world, made.id)).toMatchObject({
      startedAt: expect.any(String),
      revision: appliedTask(first).revision,
    });
    const audit = await world.db.app.withBusiness(world.business, readAuditEvents);
    expect(
      audit.filter((row) => row.operation_id === request.operationId && row.outcome === 'applied'),
    ).toHaveLength(1);
  } finally {
    await second.close();
  }
});

it('same-state, stale and unauthorised lifecycle requests cannot reset the retained date or revision', async () => {
  const made = await makeRankTask(world);
  appliedTask(
    await rankCommand(world, {
      command: 'task.start',
      recordId: made.id,
      expectedRevision: made.revision,
    }),
  );
  await dateRankTask(world, made.id, 100);
  const before = await readRankTask(world, made.id);
  expect(
    await rankCommand(world, {
      command: 'task.start',
      recordId: made.id,
      expectedRevision: before.revision,
    }),
  ).toMatchObject({ refused: true, code: 'TRANSITION_NOT_PERMITTED' });
  expect(
    await rankCommand(world, {
      command: 'task.set_state',
      recordId: made.id,
      expectedRevision: made.revision,
      stateId: await stateId('on_hold'),
    }),
  ).toMatchObject({ refused: true, code: 'VERSION_STALE' });
  expect(
    await rankCommand(
      world,
      {
        command: 'task.set_state',
        recordId: made.id,
        expectedRevision: before.revision,
        stateId: await stateId('on_hold'),
      },
      world.nobody,
    ),
  ).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
  expect(await readRankTask(world, made.id)).toStrictEqual(before);
});

it.each([null, '2080-01-01T00:00:00.000Z'])(
  'the real stored %s date has neutral age on task and board reads',
  async (started_at) => {
    const made = await makeRankTask(world);
    appliedTask(
      await rankCommand(world, {
        command: 'task.update',
        recordId: made.id,
        expectedRevision: made.revision,
        fields: { started_at },
      }),
    );
    const task = await readRankTask(world, made.id);
    expect(task.startedAt).toBe(started_at);
    expect(task.rank.score).toBe(504);
    expect(task.rank.calc).toContain('age 1 = 504');
    expect(
      (await readRankBoard(world)).tasks.find((row) => row.id === made.id)?.rank,
    ).toStrictEqual(task.rank);
  },
);

it('starting and stopping a real time entry leaves the task lifecycle and rank date unchanged', async () => {
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, world.owner, 'write', { kind: 'business', id: null }, false, 'time');
  });
  const made = await makeRankTask(world);
  const before = await readRankTask(world, made.id);
  const started = await rankCommand(world, { command: 'time.start', taskId: made.id });
  if (isCommandRefusal(started)) throw new Error(`Time start refused ${started.code}`);
  const entryId = started.detail['entryId'];
  if (typeof entryId !== 'string') throw new Error('Time start returned no entry');
  const stopped = await rankCommand(world, {
    command: 'time.stop',
    taskId: made.id,
    expectedEntryId: entryId,
  });
  expect(isCommandRefusal(stopped)).toBe(false);
  const after = await readRankTask(world, made.id);
  expect(after.state).toStrictEqual(before.state);
  expect(after.startedAt).toBeNull();
  expect(after.rank).toStrictEqual(before.rank);
});

it('duplicate starts a fresh unstarted shell and steps without copying the original age', async () => {
  const made = await makeRankTask(world);
  await dateRankTask(world, made.id, 100);
  const answer = await rankCommand(world, {
    command: 'task.duplicate',
    recordId: made.id,
    client: null,
    title: 'Fresh duplicate',
    stepNames: ['Fresh step'],
    confirmCarried: true,
  });
  const copy = appliedTask(answer);
  const task = await readRankTask(world, copy.id);
  expect(task).toMatchObject({ startedAt: null, state: { machineCategory: 'unstarted' } });
  const [step] = task.steps;
  if (step === undefined) throw new Error('Duplicate returned no step');
  expect(await readRankTask(world, step.id)).toMatchObject({
    startedAt: null,
    state: { machineCategory: 'unstarted' },
  });
});

it('trash and restore retain first-start evidence while the deleted task leaves the rank pool', async () => {
  const made = await makeRankTask(world);
  await dateRankTask(world, made.id, 100);
  const before = await readRankTask(world, made.id);
  const trashed = await rankCommand(world, {
    command: 'task.trash',
    recordId: made.id,
    expectedRevision: before.revision,
  });
  if (isCommandRefusal(trashed)) throw new Error(`Trash refused ${trashed.code}`);
  expect((await readRankBoard(world)).tasks.some((task) => task.id === made.id)).toBe(false);
  const batchId = trashed.detail['batchId'];
  if (typeof batchId !== 'string') throw new Error('Trash returned no batch');
  const restored = await rankCommand(world, { command: 'task.restore', batchId });
  expect(isCommandRefusal(restored)).toBe(false);
  expect(await readRankTask(world, made.id)).toMatchObject({
    startedAt: before.startedAt,
    rank: { score: 756 },
  });
});

it.each([
  { seconds: 7 * 86_400 - 60, score: 504 },
  { seconds: 7 * 86_400 + 60, score: 529 },
])(
  'a stored date $seconds seconds old uses whole weeks from the database clock',
  async ({ seconds, score }) => {
    const made = await makeRankTask(world);
    const [clock] = await world.db.admin.execute<{ readonly date: Date }>(
      'select clock_timestamp() - make_interval(secs => $1::int) as date',
      [seconds],
    );
    if (clock === undefined) throw new Error('Database date unavailable');
    appliedTask(
      await rankCommand(world, {
        command: 'task.update',
        recordId: made.id,
        expectedRevision: made.revision,
        fields: { started_at: clock.date.toISOString() },
      }),
    );
    expect((await readRankTask(world, made.id)).rank.score).toBe(score);
  },
);

it('canonical grant revocation removes the aged task from the reader pool and a repeated read discloses no retained date', async () => {
  const made = await makeRankTask(world);
  await dateRankTask(world, made.id, 100);
  const grantId = await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, world.owner, 'manage');
    return await grantTo(tx, world.reader, 'read', { kind: 'record', id: made.id });
  });
  const permitted = await readRankTask(world, made.id, world.reader);
  expect(permitted.rank).toMatchObject({ number: 1, score: 756 });
  const revoked = await rankCommand(world, { command: 'grant.revoke', grantId });
  expect(isCommandRefusal(revoked)).toBe(false);
  await assertRevokedRankReads(world, made.id, permitted.startedAt);
});
