// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-6 isolation for the `time.*` commands and `task.read`'s time: another
// business, another client in the same business, another person (RS-VAULT-9:
// a person sees their own time, never a leaderboard), and an agent under a
// live delegation, each with a canary that never reaches an answer.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type {
  HistoryEntry,
  TaskLedgerResult,
  TaskTimeView,
} from '../../packages/core-wire/src/index.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { grantTo, shareWithClient, type Member } from './fixture.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { agentWorld, codeOf, detailOf, type AgentWorld } from './agent-fixture.ts';
import { CANARY, WHOLE, entryIdOf, outcomeOf, timeWorld, type TimeWorld } from './time-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'task-time-isolation: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const NOT_FOUND = { code: 'NOT_FOUND', names: [] };

let w: TimeWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await timeWorld('tti');
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

describe.skipIf(serverUrl === undefined)('MP-4-6 isolation: another business', () => {
  it('another business: its task takes no entry from here, and its entries are never touched', async () => {
    const foreign = await w.fresh(w.bravo, w.bravoOwner, CANARY);
    const foreignEntry = entryIdOf(
      await w.as(w.bravo, w.bravoOwner, {
        command: 'time.log',
        taskId: foreign,
        duration: '45',
        note: CANARY,
      }),
    );
    for (const body of [
      { command: 'time.start', taskId: foreign },
      { command: 'time.log', taskId: foreign, duration: '5' },
      { command: 'time.stop', taskId: foreign },
      { command: 'time.set_note', entryId: foreignEntry, note: 'x' },
      { command: 'time.delete', entryId: foreignEntry },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const answer = await w.as(w.alpha, w.ada, body);
      expect(codeOf(answer), body.command).toBe('NOT_FOUND');
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
    expect((await w.entries(foreign)).map((row) => [row.note, row.deleted])).toStrictEqual([
      [CANARY, false],
    ]);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-6 isolation: another client', () => {
  it('another client: a reader of client A’s task times it, and client B’s is not found', async () => {
    const taskA = await w.fresh(w.alpha, w.ada, 'client A');
    const taskB = await w.fresh(w.alpha, w.ada, CANARY);
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, w.clientA, 'read', { kind: 'record', id: taskA });
    });
    const own = await w.as(w.alpha, w.clientA, {
      command: 'time.log',
      taskId: taskA,
      duration: '5',
    });
    expect(outcomeOf(own)).toStrictEqual({ applied: true });
    for (const body of [
      { command: 'time.start', taskId: taskB },
      { command: 'time.log', taskId: taskB, duration: '5' },
      { command: 'time.stop', taskId: taskB },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const answer = await w.as(w.alpha, w.clientA, body);
      expect(outcomeOf(answer), body.command).toStrictEqual(NOT_FOUND);
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
    expect(await w.entries(taskB)).toHaveLength(0);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-6 isolation: another person', () => {
  it('MP-4-6 a person sees their own time: another person’s entries are never sent or changed', async () => {
    const task = await w.fresh(w.alpha, w.ada, 'shared work');
    const log = { command: 'time.log', taskId: task };
    const adaEntry = entryIdOf(
      await w.as(w.alpha, w.ada, { ...log, duration: '30', note: CANARY }),
    );
    await w.as(w.alpha, w.noah, { ...log, duration: '10', note: 'mine' });
    await w.as(w.alpha, w.ada, { command: 'time.start', taskId: task });
    const forNoah = await w.timeOf(w.alpha, w.noah, task);
    expect(forNoah.time?.entries.map((entry) => [entry.minutes, entry.note])).toStrictEqual([
      [10, 'mine'],
    ]);
    // The task's burn is everyone's finished minutes, one number with no names.
    expect(forNoah.time?.totalMinutes).toBe(40);
    expect(forNoah.time?.running).toBeNull();
    expect(forNoah.body).not.toContain(CANARY);
    expect(forNoah.body).not.toContain(adaEntry);
    for (const body of [
      { command: 'time.set_note', entryId: adaEntry, note: 'x' },
      { command: 'time.delete', entryId: adaEntry },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const answer = await w.as(w.alpha, w.noah, body);
      expect(outcomeOf(answer), body.command).toStrictEqual(NOT_FOUND);
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
    // Noah's stop on the task stops nothing of Ada's.
    expect(codeOf(await w.as(w.alpha, w.noah, { command: 'time.stop', taskId: task }))).toBe(
      'NOT_FOUND',
    );
    const forAda = await w.timeOf(w.alpha, w.ada, task);
    expect(forAda.time?.entries.map((entry) => entry.note)).toStrictEqual(['', CANARY]);
    expect(forAda.time?.running).not.toBeNull();
    await w.as(w.alpha, w.ada, { command: 'time.stop', taskId: task });
  });
});

const isTime = (operation: string): boolean => operation.startsWith('time.');
const readOf = (recordId: string) => ({ read: 'task.read', recordId }) as const;
const LEDGER = { read: 'task.ledger', timeZone: 'UTC' } as const;

/** The task's `task.read` history as `member` reads it: who did what to it. */
async function historyFor(member: Member, taskId: string): Promise<readonly HistoryEntry[]> {
  const read = await executeRead(w.db.app, w.alpha, member.presented, readOf(taskId));
  if (isCommandRefusal(read) || !('task' in read)) throw new Error('task.read refused');
  return read.task.history;
}

/** The ledger's events on the task, as `member` reads it. */
async function ledgerFor(member: Member, taskId: string) {
  const ledger = await executeRead(w.db.app, w.alpha, member.presented, LEDGER);
  if (isCommandRefusal(ledger)) throw new Error(`task.ledger refused ${ledger.code}`);
  const [key] = await w.db.admin.execute<{ readonly key: string }>(
    'select txt_1 as key from public.records where id = $1',
    [taskId],
  );
  return (ledger as TaskLedgerResult).days
    .flatMap((day) => day.events)
    .filter((event) => event.task.key === key?.key);
}

/** Ada logs, starts and stops on the task, and Noah logs on it. */
async function adaAndNoahTime(task: string): Promise<void> {
  const log = { command: 'time.log', taskId: task };
  for (const [member, body] of [
    [w.ada, { ...log, duration: '30' }],
    [w.ada, { command: 'time.start', taskId: task }],
    [w.ada, { command: 'time.stop', taskId: task }],
    [w.noah, { ...log, duration: '10' }],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- in order: the stop needs the start
    expect(outcomeOf(await w.as(w.alpha, member, body)), body.command).toStrictEqual({
      applied: true,
    });
  }
}

/** A client the task is shared with: whether its view names a time event, and its ledger's answer. */
async function outsideReads(task: string): Promise<[boolean, string]> {
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, w.ada, 'share');
  });
  const outside = await shareWithClient(w.db.app, w.alpha, w.ada, task);
  const shared = await executeRead(w.db.app, w.alpha, outside.presented, readOf(task));
  if (isCommandRefusal(shared)) throw new Error(`shared task.read refused ${shared.code}`);
  const ledger = await executeRead(w.db.app, w.alpha, outside.presented, LEDGER);
  return [
    /"time\./u.test(JSON.stringify(shared)),
    isCommandRefusal(ledger) ? ledger.code : 'served',
  ];
}

describe.skipIf(serverUrl === undefined)('RS-VAULT-9 isolation: the task’s history', () => {
  it("another person's time.* events are not in task.read history or task.ledger", async () => {
    const task = await w.fresh(w.alpha, w.ada, 'shared history');
    await adaAndNoahTime(task);
    // An internal member (Noah): the task's creation shows, Ada's time does not.
    const history = await historyFor(w.noah, task);
    expect(history.map((entry) => entry.operation)).toContain('task.create');
    expect(
      history.filter((entry) => isTime(entry.operation) && entry.actorId !== w.noah.actorId),
    ).toStrictEqual([]);
    const ledger = await ledgerFor(w.noah, task);
    expect(ledger.map((event) => event.operation)).toContain('task.create');
    expect(
      ledger.filter((event) => isTime(event.operation) && event.actorName !== 'noah'),
    ).toStrictEqual([]);
    // An outside reader: the shared view names no time event, and the ledger is not theirs.
    expect(await outsideReads(task)).toStrictEqual([false, 'NOT_FOUND']);
  });
});

/** An agent's picked-up task, with a time entry its decider logged on it. */
async function agentWithEntry() {
  const world = await agentWorld('tta', `time-agent-${randomUUID().slice(0, 8)}`);
  const decider = await world.decider('decider');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, decider, 'write', WHOLE, false, 'time');
  });
  const picked = await world.pickUp(decider, 'the agent’s task');
  const logged = await world.asPerson(decider, {
    command: 'time.log',
    operationId: randomUUID(),
    taskId: picked.taskId,
    duration: '25',
    note: CANARY,
  });
  return { world, picked, logged };
}

/** The operations in the agent's `task.read` history of its own task. */
async function agentHistory(
  world: AgentWorld,
  picked: { readonly taskId: string; readonly credential: string },
): Promise<readonly string[]> {
  const read = await world.asAgent(
    { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
    picked.credential,
  );
  const task = detailOf(read)['task'] as { history: readonly HistoryEntry[] };
  return task.history.map((entry) => entry.operation);
}

describe.skipIf(serverUrl === undefined)(
  'MP-4-6 isolation: an agent under a live delegation',
  () => {
    let world: AgentWorld;
    let picked: { readonly taskId: string; readonly credential: string };
    let logged: CommandResult;

    beforeAll(async () => {
      ({ world, picked, logged } = await agentWithEntry());
    }, 180_000);

    afterAll(async () => {
      await world?.drop();
    });

    it('is sent no time on its own task, and reaches none of the five', async () => {
      const entryId = entryIdOf(logged);
      const read = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
        picked.credential,
      );
      expect((detailOf(read)['task'] as { time: TaskTimeView | null }).time).toBeNull();
      expect(JSON.stringify(read)).not.toContain(CANARY);
      for (const body of [
        { command: 'time.start', taskId: picked.taskId },
        { command: 'time.log', taskId: picked.taskId, duration: '5' },
        { command: 'time.set_note', entryId, note: 'x' },
        { command: 'time.delete', entryId },
      ]) {
        // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
        const answer = await world.asAgent(
          { ...body, operationId: randomUUID() },
          picked.credential,
        );
        expect(codeOf(answer), body.command).not.toBe('not-a-refusal');
        expect(JSON.stringify(answer)).not.toContain(CANARY);
      }
      const rows = await world.db.admin.execute<{ readonly note: string; readonly gone: boolean }>(
        `select note, deleted_at is not null as gone from public.time_entries where task_id = $1`,
        [picked.taskId],
      );
      expect(rows.map((row) => [row.note, row.gone])).toStrictEqual([[CANARY, false]]);
    });

    it("the decider's time.* events are not in the agent's task.read history", async () => {
      const operations = await agentHistory(world, picked);
      expect(operations).toContain('task.create');
      expect(operations.filter((operation) => isTime(operation))).toStrictEqual([]);
    });
  },
);
