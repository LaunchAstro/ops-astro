// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readAuditEvents } from '../../packages/core-commands/src/commands/audit.ts';
import {
  appliedTask,
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

it.each([
  { label: 'absent', fields: {}, expected: null },
  { label: 'null', fields: { started_at: null }, expected: null },
  {
    label: 'past',
    fields: { started_at: '2000-01-01T00:00:00.000Z' },
    expected: '2000-01-01T00:00:00.000Z',
  },
  {
    label: 'future',
    fields: { started_at: '2080-01-01T00:00:00.000Z' },
    expected: '2080-01-01T00:00:00.000Z',
  },
])(
  'creation in a started state persists the $label first-start input on the database clock',
  async ({ fields, expected }) => {
    const [clock] = await world.db.admin.execute<{ readonly instant: Date }>(
      'select clock_timestamp() as instant',
    );
    if (clock === undefined) throw new Error('Database clock unavailable');
    const made = appliedTask(
      await rankCommand(world, {
        command: 'task.create',
        stateKey: 'active',
        fields: { title: 'Created already active', ...fields },
      }),
    );
    const task = await readRankTask(world, made.id);
    expect(task.state?.machineCategory).toBe('started');
    expect(task.startedAt).toEqual(expect.any(String));
    if (expected === null) {
      expect(Date.parse(task.startedAt ?? '') - clock.instant.getTime()).toBeGreaterThanOrEqual(0);
      expect(Date.parse(task.startedAt ?? '') - clock.instant.getTime()).toBeLessThan(60_000);
    } else expect(task.startedAt).toBe(expected);
    const [stored] = await world.db.admin.execute<{ readonly start: Date }>(
      "select (data ->> 'started_at')::timestamptz as start from records where business_id = $1 and id = $2",
      [world.business, made.id],
    );
    expect(stored?.start.toISOString()).toBe(task.startedAt);
    expect((await readRankBoard(world)).tasks.find((row) => row.id === made.id)?.startedAt).toBe(
      task.startedAt,
    );
  },
);

it('creation in an unstarted state retains an absent start rather than fabricating history', async () => {
  const made = appliedTask(
    await rankCommand(world, { command: 'task.create', fields: { title: 'Never started' } }),
  );
  expect(await readRankTask(world, made.id)).toMatchObject({
    startedAt: null,
    state: { machineCategory: 'unstarted' },
  });
});

it('the exact created-started operation replays one task, start stamp and applied audit event', async () => {
  const request = {
    command: 'task.create',
    operationId: randomUUID(),
    stateKey: 'active',
    fields: { title: 'Created-started replay' },
  } as const;
  const first = await rankCommand(world, request);
  const made = appliedTask(first);
  const before = await readRankTask(world, made.id);
  expect(before.startedAt).toEqual(expect.any(String));
  expect(await rankCommand(world, request)).toStrictEqual(first);
  expect(await readRankTask(world, made.id)).toStrictEqual(before);
  const events = await world.db.app.withBusiness(world.business, readAuditEvents);
  expect(
    events.filter((row) => row.operation_id === request.operationId && row.outcome === 'applied'),
  ).toHaveLength(1);
});

it('a protected completed create and invalid date create refuse without inserting a task', async () => {
  const count = async () =>
    (
      await world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from records where business_id = $1',
        [world.business],
      )
    )[0]?.n;
  const before = await count();
  const completed = await rankCommand(world, {
    command: 'task.create',
    stateKey: 'complete',
    fields: { title: 'Refused completed create' },
  });
  expect(completed).toMatchObject({ refused: true, code: 'TRANSITION_PROTECTED' });
  const invalid = await rankCommand(world, {
    command: 'task.create',
    stateKey: 'active',
    fields: { title: 'Refused date', started_at: 'not-a-date' },
  });
  expect(invalid).toMatchObject({ refused: true, code: 'FIELD_VALUE_INVALID' });
  expect(await count()).toBe(before);
});
