// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-6's command step: the five `time.*` commands (CS-4.1, CS-4.28 to
// CS-4.30) and the `time` field of `task.read`, through the envelope and the
// read path against a real database. The crossings are in
// `task-time-isolation.test.ts`.
//
// Each command is `time:write`, asked of the business, and then `task:read`
// on the task it names. An entry is always the session's person's.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import type { Member } from './fixture.ts';
import { codeOf, detailOf } from './agent-fixture.ts';
import { entryIdOf, outcomeOf, timeWorld, type TimeWorld } from './time-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task-time: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

const TIME_COMMANDS = ['time.start', 'time.stop', 'time.log', 'time.set_note', 'time.delete'];
const REFUSED_BY_TIMER = { code: 'TRANSITION_NOT_PERMITTED', names: ['timer'] };

let w: TimeWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await timeWorld('tt');
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

const run = async (member: Member, body: Record<string, unknown>) =>
  await w.as(w.alpha, member, body);

describe('MP-4-6 time commands are declared', () => {
  it('as time:write, asked of the business, never an agent', () => {
    const rows = COMMAND_SURFACE.filter((row) => TIME_COMMANDS.includes(String(row.name)));
    expect(rows.map((row) => row.name).toSorted()).toStrictEqual(TIME_COMMANDS.toSorted());
    for (const row of rows) {
      expect([row.kind, row.collection, row.action, row.authorisedOn, row.agent]).toStrictEqual([
        'write',
        'time',
        'write',
        'business',
        'never',
      ]);
    }
  });
});

describe.skipIf(serverUrl === undefined)(
  'MP-4-6 timer start and stop, through the commands',
  () => {
    it('the owner’s check: Start, a minute, Stop, and the entry with its minutes is on the read', async () => {
      const task = await w.fresh(w.alpha, w.ada, 'owner check');
      const started = await run(w.ada, { command: 'time.start', taskId: task });
      expect(outcomeOf(started)).toStrictEqual({ applied: true });
      expect((await w.timeOf(w.alpha, w.ada, task)).time?.running?.entryId).toBe(
        entryIdOf(started),
      );
      await w.backdate(w.ada, 61);
      const stopped = await run(w.ada, { command: 'time.stop', taskId: task });
      expect(detailOf(stopped)['minutes']).toBe(2);
      const after = await w.timeOf(w.alpha, w.ada, task);
      expect(after.time?.running).toBeNull();
      expect(after.time?.entries.map((entry) => entry.minutes)).toStrictEqual([2]);
      expect(after.time?.totalMinutes).toBe(2);
    });

    it('R77: a stop names its task and stops only the timer running against it', async () => {
      const [panel, other] = [
        await w.fresh(w.alpha, w.ada, 'panel'),
        await w.fresh(w.alpha, w.ada, 'other'),
      ];
      await run(w.ada, { command: 'time.start', taskId: other });
      const closed = await run(w.ada, { command: 'time.stop', taskId: panel });
      expect(outcomeOf(closed)).toStrictEqual({ code: 'NOT_FOUND', names: ['timer'] });
      expect((await w.timeOf(w.alpha, w.ada, other)).time?.running).not.toBeNull();
      await run(w.ada, { command: 'time.stop', taskId: other });
    });
  },
);

describe.skipIf(serverUrl === undefined)('MP-4-6 logging parses, through time.log', () => {
  it('CS-4.28: a duration is parsed; one that is not a length of time is refused and writes nothing', async () => {
    const task = await w.fresh(w.alpha, w.ada, 'logged');
    const logged = await run(w.ada, {
      command: 'time.log',
      taskId: task,
      duration: '1h 30m',
      note: 'drafting',
    });
    expect(outcomeOf(logged)).toStrictEqual({ applied: true });
    for (const duration of ['1h 70', 'soon', 90, null]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const bad = await run(w.ada, { command: 'time.log', taskId: task, duration });
      expect(outcomeOf(bad)).toStrictEqual({ code: 'FIELD_VALUE_INVALID', names: ['duration'] });
    }
    expect((await w.entries(task)).map((row) => [row.minutes, row.note])).toStrictEqual([
      [90, 'drafting'],
    ]);
  });
});

describe.skipIf(serverUrl === undefined)(
  'MP-4-6 one running timer per person, through the commands',
  () => {
    it('CS-4.1: a second start is refused naming the timer; two at once leave one', async () => {
      const one = await w.fresh(w.alpha, w.noah, 'one');
      const two = await w.fresh(w.alpha, w.noah, 'two');
      await run(w.noah, { command: 'time.start', taskId: one });
      const second = await run(w.noah, { command: 'time.start', taskId: two });
      expect(outcomeOf(second)).toStrictEqual(REFUSED_BY_TIMER);
      await run(w.noah, { command: 'time.stop', taskId: one });
      const both = await Promise.all(
        [one, two].map(async (taskId) => await run(w.noah, { command: 'time.start', taskId })),
      );
      expect(both.map((answer) => codeOf(answer)).toSorted()).toStrictEqual([
        'TRANSITION_NOT_PERMITTED',
        'not-a-refusal',
      ]);
      const live = await w.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.time_entries
        where person_id = $1 and ended_at is null and deleted_at is null`,
        [w.noah.personId],
      );
      expect(live[0]?.n).toBe('1');
      await Promise.all(
        [one, two].map(async (taskId) => await run(w.noah, { command: 'time.stop', taskId })),
      );
    });
  },
);

describe.skipIf(serverUrl === undefined)('MP-4-6 notes and deletes, through the commands', () => {
  it('CS-4.29 and CS-4.30: a note edits and an entry deletes; a running one is stopped first', async () => {
    const task = await w.fresh(w.alpha, w.ada, 'notes');
    const entryId = entryIdOf(
      await run(w.ada, { command: 'time.log', taskId: task, duration: '20m' }),
    );
    const noted = await run(w.ada, { command: 'time.set_note', entryId, note: 'edited' });
    expect(outcomeOf(noted)).toStrictEqual({ applied: true });
    expect((await w.entries(task))[0]?.note).toBe('edited');
    const typed = await run(w.ada, { command: 'time.set_note', entryId, note: 7 });
    expect(outcomeOf(typed)).toStrictEqual({ code: 'FIELD_VALUE_INVALID', names: ['note'] });
    const gone = await run(w.ada, { command: 'time.delete', entryId });
    expect(outcomeOf(gone)).toStrictEqual({ applied: true });
    expect((await w.timeOf(w.alpha, w.ada, task)).time?.entries).toStrictEqual([]);
    const running = entryIdOf(await run(w.ada, { command: 'time.start', taskId: task }));
    const refused = await run(w.ada, { command: 'time.delete', entryId: running });
    expect(outcomeOf(refused)).toStrictEqual(REFUSED_BY_TIMER);
    await run(w.ada, { command: 'time.stop', taskId: task });
  });
});

/** Each labelled operation's audit event, in chain order, as `[label, command, who, outcome, code]`. */
async function auditOf(ops: Readonly<Record<string, string>>) {
  const events = await w.db.admin.execute<{
    readonly operation_id: string;
    readonly command: string;
    readonly actor_id: string;
    readonly outcome: string;
    readonly refusal_code: string | null;
  }>(
    `select operation_id, command, actor_id, outcome, refusal_code from public.audit_events
      where business_id = $1 and operation_id = any($2::text[]) order by seq`,
    [w.alpha, Object.values(ops)],
  );
  const label = Object.fromEntries(Object.entries(ops).map(([key, value]) => [value, key]));
  return events.map((event) => [
    label[event.operation_id],
    event.command,
    event.actor_id === w.ada.actorId ? 'ada' : 'noah',
    event.outcome,
    event.refusal_code,
  ]);
}

describe.skipIf(serverUrl === undefined)('MP-4-6 audit read-back', () => {
  it('each command writes its change and its refusal to the audit chain, by its own name', async () => {
    const task = await w.fresh(w.alpha, w.ada, 'audited');
    const ops: Record<string, string> = {};
    const step = async (label: string, member: Member, body: Record<string, unknown>) => {
      ops[label] = randomUUID();
      return await run(member, { ...body, operationId: ops[label] });
    };
    await step('start', w.ada, { command: 'time.start', taskId: task });
    await step('start again', w.ada, { command: 'time.start', taskId: task });
    await step('stop', w.ada, { command: 'time.stop', taskId: task });
    const logged = await step('log', w.ada, { command: 'time.log', taskId: task, duration: '15' });
    const entryId = entryIdOf(logged);
    await step('note', w.ada, { command: 'time.set_note', entryId, note: 'n' });
    await step('note by another', w.noah, { command: 'time.set_note', entryId, note: 'x' });
    await step('delete', w.ada, { command: 'time.delete', entryId });
    // `toEqual`: the driver's rows are not plain objects.
    expect(await auditOf(ops)).toEqual([
      ['start', 'time.start', 'ada', 'applied', null],
      ['start again', 'time.start', 'ada', 'refused', 'TRANSITION_NOT_PERMITTED'],
      ['stop', 'time.stop', 'ada', 'applied', null],
      ['log', 'time.log', 'ada', 'applied', null],
      ['note', 'time.set_note', 'ada', 'applied', null],
      ['note by another', 'time.set_note', 'noah', 'refused', 'NOT_FOUND'],
      ['delete', 'time.delete', 'ada', 'applied', null],
    ]);
    // Each change and its record committed together.
    expect((await w.entries(task)).map((row) => [row.minutes, row.deleted])).toStrictEqual([
      [1, false],
      [15, true],
    ]);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-6 time:write refused', () => {
  it('a task reader and writer without time:write is refused all five, and nothing is written', async () => {
    const task = await w.fresh(w.alpha, w.ada, 'not granted');
    const entryId = entryIdOf(
      await run(w.ada, { command: 'time.log', taskId: task, duration: '5' }),
    );
    const bodies = [
      { command: 'time.start', taskId: task },
      { command: 'time.stop', taskId: task },
      { command: 'time.log', taskId: task, duration: '10' },
      { command: 'time.set_note', entryId, note: 'x' },
      { command: 'time.delete', entryId },
    ];
    for (const body of bodies) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const answer = await run(w.taskOnly, body);
      expect(outcomeOf(answer), body.command).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect(JSON.stringify(answer)).not.toContain(entryId);
    }
    expect((await w.entries(task)).map((row) => [row.person_id, row.note])).toStrictEqual([
      [w.ada.personId, ''],
    ]);
  });
});
