// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { entryIdOf, outcomeOf, timeWorld, withTimerCleanup, type TimeWorld } from './time-world.ts';

const serverUrl = databaseUrlFromEnvironment();
let w: TimeWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await timeWorld('stopentry');
}, 180_000);
afterAll(async () => {
  await w?.db.drop();
});
const run = async (body: Record<string, unknown>) => await w.as(w.alpha, w.ada, body);
const start = async (taskId: string) => entryIdOf(await run({ command: 'time.start', taskId }));
const stop = async (taskId: string, expectedEntryId: string) =>
  await run({ command: 'time.stop', taskId, expectedEntryId });

async function running(entryId: string): Promise<boolean> {
  const rows = await w.db.admin.execute<{
    readonly running: boolean;
    readonly minutes: number | null;
  }>(`select ended_at is null as running, minutes from public.time_entries where id = $1`, [
    entryId,
  ]);
  expect(rows).toHaveLength(1);
  if (rows[0]?.running === true) expect(rows[0].minutes).toBeNull();
  return rows[0]?.running === true;
}

it.skipIf(serverUrl === undefined)(
  'matching entry succeeds with the existing rounding, and changed entry changes operation identity',
  withTimerCleanup(
    () => w,
    async () => {
      const taskId = await w.fresh(w.alpha, w.ada, 'entry digest');
      const entryA = await start(taskId);
      await w.backdate(w.ada, 61);
      const envelope = {
        command: 'time.stop',
        taskId,
        expectedEntryId: entryA,
        operationId: randomUUID(),
      };
      const answer = await run(envelope);
      expect(outcomeOf(answer)).toEqual({ applied: true });
      expect(answer).toMatchObject({ detail: { entryId: entryA, minutes: 2 } });
      const entryB = await start(taskId);
      expect(await run(envelope)).toEqual(answer);
      const reused = await run({ ...envelope, expectedEntryId: entryB });
      expect(outcomeOf(reused)).toMatchObject({ code: 'OPERATION_ID_REUSED' });
      expect(await running(entryB)).toBe(true);
      expect(entryIdOf(await stop(taskId, entryB))).toBe(entryB);
    },
  ),
);

it.skipIf(serverUrl === undefined)(
  'absent, ended and other-task entries give the same refusal and cannot end the current entry',
  withTimerCleanup(
    () => w,
    async () => {
      const taskId = await w.fresh(w.alpha, w.ada, 'entry mismatch');
      const otherTask = await w.fresh(w.alpha, w.ada, 'other task');
      const otherEntry = entryIdOf(
        await run({ command: 'time.log', taskId: otherTask, duration: '5' }),
      );
      const ended = await start(taskId);
      await stop(taskId, ended);
      const current = await start(taskId);
      const absent = await stop(taskId, randomUUID());
      const old = await stop(taskId, ended);
      const foreign = await stop(taskId, otherEntry);
      expect(outcomeOf(absent)).toEqual({ code: 'NOT_FOUND', names: ['timer'] });
      expect(outcomeOf(old)).toEqual(outcomeOf(absent));
      expect(outcomeOf(foreign)).toEqual(outcomeOf(absent));
      expect(await running(current)).toBe(true);
      expect(entryIdOf(await stop(taskId, current))).toBe(current);
    },
  ),
);

it.skipIf(serverUrl === undefined)(
  'a foreign person or business entry gives no extra oracle and leaves all live clocks alone',
  withTimerCleanup(
    () => w,
    async () => {
      const taskId = await w.fresh(w.alpha, w.ada, 'entry isolation canary');
      const own = await start(taskId);
      const noah = entryIdOf(await w.as(w.alpha, w.noah, { command: 'time.start', taskId }));
      const foreignTask = await w.fresh(w.bravo, w.bravoOwner, 'foreign entry canary');
      const bravo = entryIdOf(
        await w.as(w.bravo, w.bravoOwner, { command: 'time.start', taskId: foreignTask }),
      );
      const absent = await stop(taskId, randomUUID());
      expect(outcomeOf(await stop(taskId, noah))).toEqual(outcomeOf(absent));
      expect(outcomeOf(await stop(taskId, bravo))).toEqual(outcomeOf(absent));
      const unreadable = await w.as(w.alpha, w.clientA, {
        command: 'time.stop',
        taskId,
        expectedEntryId: noah,
      });
      const hiddenAbsent = await w.as(w.alpha, w.clientA, {
        command: 'time.stop',
        taskId,
        expectedEntryId: randomUUID(),
      });
      expect(outcomeOf(unreadable)).toEqual({ code: 'NOT_FOUND', names: [] });
      expect(outcomeOf(hiddenAbsent)).toEqual(outcomeOf(unreadable));
      const across = await stop(foreignTask, bravo);
      expect(outcomeOf(across)).toEqual({ code: 'NOT_FOUND', names: ['timer'] });
      const missingTask = await stop(randomUUID(), randomUUID());
      expect(outcomeOf(across)).toEqual(outcomeOf(missingTask));
      expect(JSON.stringify([unreadable, across])).not.toContain('canary');
      expect(await Promise.all([running(own), running(noah), running(bravo)])).toEqual([
        true,
        true,
        true,
      ]);
      await stop(taskId, own);
      await w.as(w.alpha, w.noah, { command: 'time.stop', taskId, expectedEntryId: noah });
      await w.as(w.bravo, w.bravoOwner, {
        command: 'time.stop',
        taskId: foreignTask,
        expectedEntryId: bravo,
      });
    },
  ),
);

it.skipIf(serverUrl === undefined)(
  'invalid entry operands refuse safely and omitted legacy operands retain exact replay',
  withTimerCleanup(
    () => w,
    async () => {
      const taskId = await w.fresh(w.alpha, w.ada, 'entry operands');
      const entryId = await start(taskId);
      const numeric = await run({ command: 'time.stop', taskId, expectedEntryId: 7 });
      const nil = await run({ command: 'time.stop', taskId, expectedEntryId: null });
      expect(outcomeOf(numeric)).toEqual({
        code: 'FIELD_VALUE_INVALID',
        names: ['expectedEntryId'],
      });
      expect(outcomeOf(nil)).toEqual(outcomeOf(numeric));
      expect(outcomeOf(await stop(taskId, 'not-a-uuid'))).toEqual({
        code: 'NOT_FOUND',
        names: ['timer'],
      });
      expect(await running(entryId)).toBe(true);
      const legacy = { command: 'time.stop', taskId, operationId: randomUUID() };
      const answer = await run(legacy);
      expect(entryIdOf(answer)).toBe(entryId);
      const newer = await start(taskId);
      expect(await run(legacy)).toEqual(answer);
      expect(outcomeOf(await run({ ...legacy, expectedEntryId: entryId }))).toMatchObject({
        code: 'OPERATION_ID_REUSED',
      });
      expect(await running(newer)).toBe(true);
      await stop(taskId, newer);
    },
  ),
);
