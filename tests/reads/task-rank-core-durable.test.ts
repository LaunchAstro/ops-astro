// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { taskSpineConformance } from '../../packages/core-records/src/tasks/conformance.ts';
import { domainModelConformance } from '../../packages/core-records/src/records/conformance.ts';
import { readAuditEvents } from '../../packages/core-commands/src/commands/audit.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  rankCoreWorld,
  makeRankTask,
  rankCommand,
  appliedTask,
  readRankTask,
  readRankBoard,
  dateRankTask,
  type RankCoreWorld,
} from './task-rank-core-world.ts';

let world: RankCoreWorld | undefined;
function here(): RankCoreWorld {
  if (world === undefined) throw new Error('Owned task rank database not prepared');
  return world;
}
beforeAll(async () => {
  world = await rankCoreWorld();
}, 180_000);
afterAll(async () => {
  await world?.db.drop();
});

it('the normal task start persists its first date, state and revision and replays without resetting age', async () => {
  const w = here();
  const made = await makeRankTask(w);
  const unstarted = await readRankTask(w, made.id);
  expect(unstarted.startedAt).toBeNull();
  expect(unstarted.rank.score).toBe(504);
  const request = {
    command: 'task.start',
    recordId: made.id,
    expectedRevision: made.revision,
    operationId: randomUUID(),
  } as const;
  const started = await rankCommand(w, request);
  const after = await readRankTask(w, made.id);
  expect(after.state?.machineCategory).toBe('started');
  expect(after.startedAt).toEqual(expect.any(String));
  expect(Math.abs(Date.now() - Date.parse(after.startedAt ?? ''))).toBeLessThan(60_000);
  expect(await rankCommand(w, request)).toStrictEqual(started);
  expect((await readRankTask(w, made.id)).startedAt).toBe(after.startedAt);
  expect((await readRankTask(w, made.id)).revision).toBe(after.revision);
  const audit = await w.db.app.withBusiness(w.business, async (tx) => await readAuditEvents(tx));
  expect(
    audit.filter(
      (event) => event.operation_id === request.operationId && event.outcome === 'applied',
    ),
  ).toHaveLength(1);
});

it.each([
  { days: 10, score: 529, age: 'age 1.05 (1 week)' },
  { days: 15, score: 554, age: 'age 1.1 (2 weeks)' },
  { days: 100, score: 756, age: 'age 1.5 (10 weeks)' },
])(
  'a real stored start $days days ago gives $score on the page and board',
  async ({ days, score, age }) => {
    const w = here();
    const made = await makeRankTask(w);
    appliedTask(
      await rankCommand(w, {
        command: 'task.start',
        recordId: made.id,
        expectedRevision: made.revision,
      }),
    );
    await dateRankTask(w, made.id, days);
    const task = await readRankTask(w, made.id);
    const board = await readRankBoard(w);
    expect(task.rank.score).toBe(score);
    expect(task.rank.calc).toContain(age);
    expect(board.tasks.find((row) => row.id === made.id)?.rank).toStrictEqual(task.rank);
    expect(board.tasks.find((row) => row.id === made.id)?.startedAt).toBe(task.startedAt);
  },
);

it('a done task keeps its date but has neutral age and no open-pool number, then reopening preserves the date', async () => {
  const w = here();
  const made = await makeRankTask(w);
  await dateRankTask(w, made.id, 100);
  const old = await readRankTask(w, made.id);
  const done = appliedTask(
    await rankCommand(w, {
      command: 'task.complete',
      recordId: made.id,
      expectedRevision: old.revision,
    }),
  );
  const task = await readRankTask(w, made.id);
  expect(task.startedAt).toBe(old.startedAt);
  expect(task.rank).toMatchObject({
    score: 504,
    number: null,
    calc: expect.stringContaining('age 1 = 504'),
  });
  const board = await readRankBoard(w);
  expect(board.tasks.find((row) => row.id === made.id)?.rank).toStrictEqual(task.rank);
  appliedTask(
    await rankCommand(w, {
      command: 'task.reopen',
      recordId: made.id,
      expectedRevision: done.revision,
      reason: 'Synthetic rank regression',
    }),
  );
  const reopened = await readRankTask(w, made.id);
  expect(reopened.startedAt).toBe(old.startedAt);
  expect(reopened.rank.score).toBe(756);
});

it('a start date cleared through task.update stays neutral and missing marks stay unranked', async () => {
  const w = here();
  const made = await makeRankTask(w);
  await dateRankTask(w, made.id, 15);
  await dateRankTask(w, made.id, null);
  const task = await readRankTask(w, made.id);
  expect(task.startedAt).toBeNull();
  expect(task.rank.score).toBe(504);
  const missing = await makeRankTask(w, [5, 7, null]);
  await dateRankTask(w, missing.id, 100);
  expect((await readRankTask(w, missing.id)).rank).toStrictEqual({
    number: null,
    score: null,
    calc: 'not ranked: missing ease',
  });
});

it('actual two-week age rounds the exact 27.5 halfway case up to 28', async () => {
  const w = here();
  const made = await makeRankTask(w, [1, 5, 5]);
  await dateRankTask(w, made.id, 15);
  expect((await readRankTask(w, made.id)).rank.score).toBe(28);
});

it('equal real scores use the stored hand order without changing the score', async () => {
  const w = here();
  const first = await makeRankTask(w);
  const second = await makeRankTask(w);
  appliedTask(
    await rankCommand(w, {
      command: 'task.rank',
      recordId: second.id,
      expectedRevision: second.revision,
      beforeId: first.id,
    }),
  );
  const a = await readRankTask(w, first.id);
  const b = await readRankTask(w, second.id);
  expect([a.rank.score, b.rank.score]).toStrictEqual([504, 504]);
  expect(b.rank.number).toBeLessThan(a.rank.number ?? 0);
  const board = await readRankBoard(w);
  expect(board.tasks.find((row) => row.id === second.id)?.rank).toStrictEqual(b.rank);
});

it('date and start writes need task:write and stale updates cannot change the stored rank input', async () => {
  const w = here();
  const made = await makeRankTask(w);
  const refusedStart = await rankCommand(
    w,
    { command: 'task.start', recordId: made.id, expectedRevision: made.revision },
    w.nobody,
  );
  expect(refusedStart).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
  const refusedDate = await rankCommand(
    w,
    {
      command: 'task.update',
      recordId: made.id,
      expectedRevision: made.revision,
      fields: { started_at: '2026-01-01T00:00:00.000Z' },
    },
    w.nobody,
  );
  expect(refusedDate).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
  await dateRankTask(w, made.id, 10);
  const held = await readRankTask(w, made.id);
  const stale = await rankCommand(w, {
    command: 'task.update',
    recordId: made.id,
    expectedRevision: made.revision,
    fields: { started_at: null },
  });
  expect(stale).toMatchObject({ refused: true, code: 'VERSION_STALE' });
  expect((await readRankTask(w, made.id)).startedAt).toBe(held.startedAt);
});

it('a high aged other-client or other-business task neither leaks nor shifts the client reader pool', async () => {
  const w = here();
  const visible = await makeRankTask(w, [7, 9, 8], w.client);
  await dateRankTask(w, visible.id, 10);
  const hidden = await makeRankTask(w, [10, 10, 10]);
  await dateRankTask(w, hidden.id, 100);
  const foreign = await makeRankTask(w, [10, 10, 10], null, w.otherOwner, w.foreign);
  // A party grant admits client facts, not task records. A narrow task grant
  // is required, as in the normal client-reach fixtures. It widens no pool.
  const partyOnly = await executeRead(w.db.app, w.business, w.reader.presented, {
    read: 'task.read',
    recordId: visible.id,
  });
  expect(partyOnly).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
  await w.db.app.withBusiness(w.business, async (tx) => {
    await grantTo(tx, w.reader, 'read', { kind: 'record', id: visible.id });
  });
  const read = await readRankTask(w, visible.id, w.reader);
  expect(read.rank).toMatchObject({ number: 1, score: 529 });
  const board = await readRankBoard(w, w.reader);
  expect(board.tasks.map((row) => row.id)).toStrictEqual([visible.id]);
  expect(board.tasks[0]?.rank).toStrictEqual(read.rank);
  const otherClient = await executeRead(w.db.app, w.business, w.reader.presented, {
    read: 'task.read',
    recordId: hidden.id,
  });
  expect(otherClient).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
  const otherBusiness = await executeRead(w.db.app, w.business, w.owner.presented, {
    read: 'task.read',
    recordId: foreign.id,
  });
  expect(otherBusiness).toMatchObject({ refused: true, code: 'NOT_FOUND' });
  expect(JSON.stringify([read, board, otherClient, otherBusiness])).not.toContain(hidden.id);
  expect(JSON.stringify([read, board, otherClient, otherBusiness])).not.toContain(foreign.id);
});

it('the installed protected task type and field model conform with the declared start-date classification', async () => {
  const w = here();
  expect(await taskSpineConformance(w.db.admin.execute.bind(w.db.admin))).toStrictEqual([]);
  const fields = await w.db.admin.execute<{
    readonly value_type: string;
    readonly slot: string | null;
    readonly write_mode: string;
    readonly visibility_class: string;
  }>(
    `select value_type, slot, write_mode, visibility_class from public.field_defs f join public.record_types t on t.business_id = f.business_id and t.id = f.record_type_id where t.business_id = $1 and t.key = 'task' and f.key = 'started_at'`,
    [w.business],
  );
  expect(Array.from(fields)).toStrictEqual([
    { value_type: 'timestamptz', slot: null, write_mode: 'generic', visibility_class: 'internal' },
  ]);
  const findings = await domainModelConformance(w.db.admin.execute.bind(w.db.admin));
  expect(findings, JSON.stringify(findings, null, 2)).toStrictEqual([]);
});

it('a mistyped start date is refused by the normal declared field writer without changing the task', async () => {
  const w = here();
  const badDate = await makeRankTask(w);
  const invalid = await rankCommand(w, {
    command: 'task.update',
    recordId: badDate.id,
    expectedRevision: badDate.revision,
    fields: { started_at: 'not a date' },
  });
  expect(invalid).toMatchObject({
    refused: true,
    code: 'FIELD_VALUE_INVALID',
    names: ['started_at=timestamptz'],
  });
  expect((await readRankTask(w, badDate.id)).startedAt).toBeNull();
});
