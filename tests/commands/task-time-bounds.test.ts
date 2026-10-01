// SPDX-License-Identifier: AGPL-3.0-only
//
// The `time.*` commands at their bounds (review 2c1 findings 7, 8 and 9):
//
// - A duration is length-capped before it is parsed, so a hostile one is the
//   command's usual refusal at once, never a minute inside the transaction.
// - A note is held to 0078's check of 500 characters: 501 is refused by
//   name, never a database fault.
// - A person may always stop, then delete, their own running timer after
//   losing `task:read` on its task (ORCH57 ruling on A3-3). The answer carries
//   the time entry's own fields and nothing of the task; losing access does
//   not end the timer; and another person's timer, or another business's,
//   is still refused.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo, type Member } from './fixture.ts';
import { codeOf, detailOf } from './agent-fixture.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { CANARY, entryIdOf, outcomeOf, timeWorld, type TimeWorld } from './time-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'task-time-bounds: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const NOT_FOUND = { code: 'NOT_FOUND', names: [] };

let w: TimeWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await timeWorld('ttb');
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

const run = async (member: Member, body: Record<string, unknown>) =>
  await w.as(w.alpha, member, body);

describe.skipIf(serverUrl === undefined)('MP-4-6 a hostile duration, through time.log', () => {
  it('a 10,000-character duration is refused FIELD_VALUE_INVALID at once, and writes nothing', async () => {
    const task = await w.fresh(w.alpha, w.ada, 'hostile duration');
    const started = performance.now();
    const answer = await run(w.ada, {
      command: 'time.log',
      taskId: task,
      duration: `${' '.repeat(10_000)}x`,
    });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(outcomeOf(answer)).toStrictEqual({ code: 'FIELD_VALUE_INVALID', names: ['duration'] });
    expect(await w.entries(task)).toHaveLength(0);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-6 the note limit is the database’s', () => {
  it('a note of 500 characters is kept; 501 answers FIELD_VALUE_INVALID on log and set_note', async () => {
    const task = await w.fresh(w.alpha, w.ada, 'note limit');
    const log = { command: 'time.log', taskId: task, duration: '5' };
    const kept = await run(w.ada, { ...log, note: 'n'.repeat(500) });
    expect(outcomeOf(kept)).toStrictEqual({ applied: true });
    const tooLong = 'n'.repeat(501);
    const logged = await run(w.ada, { ...log, note: tooLong });
    expect(outcomeOf(logged)).toStrictEqual({ code: 'FIELD_VALUE_INVALID', names: ['note'] });
    const noted = await run(w.ada, {
      command: 'time.set_note',
      entryId: entryIdOf(kept),
      note: tooLong,
    });
    expect(outcomeOf(noted)).toStrictEqual({ code: 'FIELD_VALUE_INVALID', names: ['note'] });
    expect((await w.entries(task)).map((row) => row.note.length)).toStrictEqual([500]);
  });
});

/** A task titled with the canary that only `clientA` times, under one record grant. */
async function timedThenRevoked(): Promise<{ readonly task: string; readonly entryId: string }> {
  const task = await w.fresh(w.alpha, w.ada, CANARY);
  const grantId = await w.db.app.withBusiness(
    w.alpha,
    async (tx) => await grantTo(tx, w.clientA, 'read', { kind: 'record', id: task }),
  );
  const started = await run(w.clientA, { command: 'time.start', taskId: task });
  expect(outcomeOf(started)).toStrictEqual({ applied: true });
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await revokeGrant(tx, grantId);
  });
  return { task, entryId: entryIdOf(started) };
}

describe.skipIf(serverUrl === undefined)(
  'MP-4-6 an own running timer after task:read is lost',
  () => {
    it('stop and delete of own running timer after task:read revoked succeed without task content', async () => {
      const { task, entryId } = await timedThenRevoked();
      // Losing access did not end the timer.
      const live = await w.db.admin.execute<{ readonly running: boolean }>(
        `select ended_at is null as running from public.time_entries where id = $1`,
        [entryId],
      );
      expect(live.map((row) => row.running)).toStrictEqual([true]);
      // The task itself is still not the person's to time.
      const again = await run(w.clientA, { command: 'time.log', taskId: task, duration: '5' });
      expect(outcomeOf(again)).toStrictEqual(NOT_FOUND);
      const stopped = await run(w.clientA, { command: 'time.stop', taskId: task });
      expect(outcomeOf(stopped)).toStrictEqual({ applied: true });
      expect(Object.keys(detailOf(stopped)).toSorted()).toStrictEqual(['entryId', 'minutes']);
      expect(JSON.stringify(stopped)).not.toContain(CANARY);
      const deleted = await run(w.clientA, { command: 'time.delete', entryId });
      expect(outcomeOf(deleted)).toStrictEqual({ applied: true });
      expect(JSON.stringify(deleted)).not.toContain(CANARY);
      expect((await w.entries(task)).map((row) => [row.id, row.deleted])).toStrictEqual([
        [entryId, true],
      ]);
      // With the timer stopped, time.start in the business works again.
      const own = await w.fresh(w.alpha, w.ada, 'readable again');
      await w.db.app.withBusiness(w.alpha, async (tx) => {
        await grantTo(tx, w.clientA, 'read', { kind: 'record', id: own });
      });
      const restarted = await run(w.clientA, { command: 'time.start', taskId: own });
      expect(outcomeOf(restarted)).toStrictEqual({ applied: true });
      await run(w.clientA, { command: 'time.stop', taskId: own });
    });
  },
);

describe.skipIf(serverUrl === undefined)('MP-4-6 a lost task:read opens no other timer', () => {
  it('another person’s running timer, and another business’s, are still refused', async () => {
    const task = await w.fresh(w.alpha, w.ada, CANARY);
    await run(w.noah, { command: 'time.start', taskId: task });
    // clientA cannot read the task and has no timer on it: Noah's is not theirs.
    const crossing = await run(w.clientA, { command: 'time.stop', taskId: task });
    expect(outcomeOf(crossing)).toStrictEqual(NOT_FOUND);
    expect(JSON.stringify(crossing)).not.toContain(CANARY);
    const foreign = await w.fresh(w.bravo, w.bravoOwner, CANARY);
    await w.as(w.bravo, w.bravoOwner, { command: 'time.start', taskId: foreign });
    const across = await run(w.ada, { command: 'time.stop', taskId: foreign });
    // Ada reads every task of her own business, so the answer names the timer she lacks there.
    expect(codeOf(across)).toBe('NOT_FOUND');
    expect(JSON.stringify(across)).not.toContain(CANARY);
    const running = await w.db.admin.execute<{ readonly task_id: string }>(
      `select task_id from public.time_entries
        where task_id = any ($1::uuid[]) and ended_at is null order by task_id`,
      [[task, foreign]],
    );
    expect(running.map((row) => row.task_id)).toStrictEqual([task, foreign].toSorted());
    expect(codeOf(await run(w.noah, { command: 'time.stop', taskId: task }))).toBe('not-a-refusal');
    expect(
      codeOf(await w.as(w.bravo, w.bravoOwner, { command: 'time.stop', taskId: foreign })),
    ).toBe('not-a-refusal');
  });
});
