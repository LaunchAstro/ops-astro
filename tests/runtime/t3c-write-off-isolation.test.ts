// SPDX-License-Identifier: AGPL-3.0-only
//
// T3c, the write-off's separations and its one path (`T3 isolation`,
// `T3 no machine path`, `T3 write-off authority`), against a real database.
//
// - Business to business: each business names the other's task and attempt
//   and finds nothing; a write-off moves only its own business's liability.
// - Client to client: an external client holding a task share and a billing
//   grant on it reaches no write-off, on its own task or another's, and no
//   refusal carries the other task's id or figures.
// - Task to task: an attempt named under another task is not found, and a
//   member's budget permission on one task does not reach another.
// - No machine path: the runtime's write-off has one caller, the command a
//   person sends; no timer, pass or worker module reaches it.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { appliedDetail, codeOf, openSchedules, type Schedules } from './schedules-harness.ts';
import { openSecond } from './t3b-harness.ts';
import { cq8World } from './cq-8-world.ts';
import { openBilling, t3d1Harness } from './t3d1-harness.ts';
import { holdOf, writeOffBody } from './t3c-harness.ts';
import type { Work } from './t2d-harness.ts';

const url = databaseUrlFromEnvironment();

if (url === undefined) {
  console.warn('runtime/t3c-write-off-isolation: DATABASE_URL is unset, so nothing below ran.');
}

const ROOT = join(import.meta.dirname, '..', '..');

/** Every source file under a directory, tests and fixtures excluded. */
function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(ts|tsx|mjs)$/u.test(file) && !file.includes('node_modules'))
    .map((file) => join(dir, file));
}

describe('T3 no machine path: one caller of the write-off', () => {
  it('only the command a person sends reaches the runtime write-off', () => {
    const callers = [...sources('packages'), ...sources('apps')]
      .filter((file) => /\bwriteOff\s*\(/u.test(readFileSync(join(ROOT, file), 'utf8')))
      .toSorted();
    expect(callers).toStrictEqual([
      'packages/core-commands/src/commands/budget-write-off.ts',
      'packages/core-runtime/src/recovery/write-off.ts',
    ]);
    // Nothing else writes the write-off's cause onto a hold.
    const causes = [...sources('packages'), ...sources('apps')]
      .filter((file) => readFileSync(join(ROOT, file), 'utf8').includes("'written_off'"))
      .toSorted();
    expect(causes).toStrictEqual(['packages/core-runtime/src/recovery/write-off.ts']);
  });
});

/** What of another client's work a refusal must never carry. */
const foreignOf = (
  w: Pick<Work, 'taskId' | 'attemptId' | 'picked' | 'decision'>,
  owner: Member,
): readonly string[] => [
  w.taskId,
  w.attemptId,
  String(w.picked['leaseId']),
  String(w.decision['reservationId']),
  owner.personId,
];

const as = async (on: Schedules, who: Member, body: object) =>
  await executeCommand(on.db.app, on.business, who.presented, 'api', body as never);

describe.skipIf(url === undefined)('T3c write-off separations', { timeout: 60_000 }, () => {
  let s: Schedules;
  let other: Schedules;
  let taskScoped: Member;
  const h = t3d1Harness(() => s);
  const o = t3d1Harness(() => other);

  beforeAll(async () => {
    s = await openSchedules('t3ciso', 1_000_000);
    await openBilling(s);
    other = await openSecond(s, 't3c-other');
    await openBilling(other);
    taskScoped = await enrol(s.db.app, s.business, 'task-scoped-billing');
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it("business to business: a write-off moves only its own business's liability", async () => {
    const mine = await h.unknownStep({ applied: false });
    const theirs = await o.unknownStep({ applied: false });
    const theirsBefore = await holdOf(other, theirs);
    const mineBefore = await holdOf(s, mine);

    // Each names the other's task and attempt, together and crossed, and finds nothing.
    for (const named of [theirs, { taskId: mine.taskId, attemptId: theirs.attemptId }]) {
      // eslint-disable-next-line no-await-in-loop
      expect(codeOf(await as(s, s.decider, writeOffBody(named, 0)))).toBe('NOT_FOUND');
    }
    expect(codeOf(await as(other, other.decider, writeOffBody(mine, 0)))).toBe('NOT_FOUND');
    expect(await holdOf(other, theirs)).toStrictEqual(theirsBefore);
    expect(await holdOf(s, mine)).toStrictEqual(mineBefore);

    appliedDetail(await as(s, s.decider, writeOffBody(mine, 0)), 'budget.write_off');
    expect(await holdOf(other, theirs)).toStrictEqual(theirsBefore);
    appliedDetail(await as(other, other.decider, writeOffBody(theirs, 100)), 'budget.write_off');
    expect(await holdOf(s, mine)).toMatchObject({ reservation_state: 'abandoned' });
    expect(await holdOf(other, theirs)).toMatchObject({ reservation_actual: '100' });
  });

  it("client to client: two clients, each granted on its own task, reach no write-off on the other's, and no body names it", async () => {
    const world = cq8World(s);
    const a = await h.unknownStep({ applied: false });
    const b = await h.unknownStep({ applied: false });
    const clientA = await world.client(s.business, s.decider, 'client-a', a.taskId);
    const clientB = await world.client(s.business, s.decider, 'client-b', b.taskId);
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, clientA, 'decide', { kind: 'record', id: a.taskId }, false, 'billing');
      await grantTo(tx, clientB, 'decide', { kind: 'record', id: b.taskId }, false, 'billing');
    });
    const before = [await holdOf(s, a), await holdOf(s, b)];
    const crossings = [
      // Each client names the other's attempt under the other's task, and under its own.
      { who: clientA, body: writeOffBody(b, 0), foreign: foreignOf(b, clientB) },
      {
        who: clientA,
        body: writeOffBody({ taskId: a.taskId, attemptId: b.attemptId }, 0),
        foreign: foreignOf(b, clientB),
      },
      { who: clientB, body: writeOffBody(a, 0), foreign: foreignOf(a, clientA) },
      {
        who: clientB,
        body: writeOffBody({ taskId: b.taskId, attemptId: a.attemptId }, 0),
        foreign: foreignOf(a, clientA),
      },
    ];
    for (const crossing of crossings) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await as(s, crossing.who, crossing.body);
      // Refused on authority: an external client's billing grant is never used (R4).
      expect(codeOf(refused)).toBe('SCOPE_NOT_GRANTED');
      const said = JSON.stringify(refused);
      for (const foreign of crossing.foreign) expect(said).not.toContain(foreign);
    }
    // R4: an external client's billing grant reaches no write-off on its own task either.
    expect(codeOf(await as(s, clientA, writeOffBody(a, 0)))).toBe('SCOPE_NOT_GRANTED');
    expect(codeOf(await as(s, clientB, writeOffBody(b, 0)))).toBe('SCOPE_NOT_GRANTED');
    expect([await holdOf(s, a), await holdOf(s, b)]).toStrictEqual(before);

    // The positive control: the business's own holder closes one client's, and only that one.
    appliedDetail(await as(s, s.decider, writeOffBody(a, 0)), 'budget.write_off');
    expect(await holdOf(s, b)).toStrictEqual(before[1]);
  });

  it("task to task: an attempt named under another task is not found; one task's grant reaches no other", async () => {
    const mine = await h.unknownStep({ applied: false });
    const theirs = await h.unknownStep({ applied: false });
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(
        tx,
        taskScoped,
        'decide',
        { kind: 'record', id: mine.taskId },
        false,
        'billing',
      );
    });
    const crossed = await as(
      s,
      s.decider,
      writeOffBody({ taskId: mine.taskId, attemptId: theirs.attemptId }, 0),
    );
    expect(codeOf(crossed)).toBe('NOT_FOUND');
    expect(isCommandRefusal(crossed) && JSON.stringify(crossed).includes(theirs.attemptId)).toBe(
      false,
    );
    expect(codeOf(await as(s, taskScoped, writeOffBody(theirs, 0)))).toBe('SCOPE_NOT_GRANTED');
    expect(await holdOf(s, theirs)).toMatchObject({ reservation_state: 'held' });
    appliedDetail(await as(s, taskScoped, writeOffBody(mine, 0)), 'budget.write_off');
  });
});
