// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-8: the Actual column read back from time entries (MP-4-6), against a
// real database. Each board row carries `actualMinutes`, every finished
// minute anyone logged on the task, the same total `task.read` answers: one
// number with no names behind it (RS-VAULT-9), derived at read and never a
// stored board field. A running timer adds nothing until it stops, and a
// deleted entry is off the next read.
//
// Crossings (`MP-5-8 isolation`): another business's total never reaches
// this board and its member is refused it; a reader of one client's task is
// served that task's total and never another client's. The agent under a
// live delegation is refused the board (mp-5-8-board-agent).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { CANARY, entryIdOf, timeWorld, type TimeWorld } from '../commands/time-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'mp-5-8-board-actual: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

interface Row {
  readonly id: string;
  readonly actualMinutes: number;
}

let w: TimeWorld;
const ids: Record<string, string> = {};
let noahEntry = '';

const board = async (business: BusinessId, member: Member) =>
  await executeRead(w.db.app, business, member.presented, { read: 'task.board', board: null });

const rowsOf = async (business: BusinessId, member: Member) => {
  const answer = await board(business, member);
  if (isCommandRefusal(answer) || !('tasks' in answer)) {
    throw new Error(`task.board did not answer: ${JSON.stringify(answer)}`);
  }
  return { rows: answer.tasks as unknown as readonly Row[], body: JSON.stringify(answer) };
};

const actualOf = (rows: readonly Row[], name: string) =>
  rows.find((row) => row.id === ids[name])?.actualMinutes;

const log = async (business: BusinessId, member: Member, task: string, duration: string) =>
  entryIdOf(
    await w.as(business, member, { command: 'time.log', taskId: task, duration, note: '' }),
  );

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('b8a');
  ids['logged'] = await w.fresh(w.alpha, w.ada, 'logged by two people');
  ids['running'] = await w.fresh(w.alpha, w.ada, 'a timer running');
  ids['other'] = await w.fresh(w.alpha, w.ada, CANARY);
  ids['bravo'] = await w.fresh(w.bravo, w.bravoOwner, CANARY);
  await log(w.alpha, w.ada, ids['logged'], '30m');
  noahEntry = await log(w.alpha, w.noah, ids['logged'], '45m');
  await w.as(w.alpha, w.ada, { command: 'time.start', taskId: ids['running'] });
  // Canary totals: 555 minutes on another client's task, 777 in another business.
  await log(w.alpha, w.ada, ids['other'], '9h 15m');
  await log(w.bravo, w.bravoOwner, ids['bravo'], '12h 57m');
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, w.clientA, 'read', { kind: 'record', id: ids['logged'] ?? '' });
  });
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

describe.skipIf(serverUrl === undefined)('MP-5-8 column read-back, actual', () => {
  it('each row’s actual is every finished minute on the task, as its task read answers', async () => {
    const { rows } = await rowsOf(w.alpha, w.ada);
    expect([actualOf(rows, 'logged'), actualOf(rows, 'running')]).toStrictEqual([75, 0]);
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop -- one read per row, compared in turn
      const { time } = await w.timeOf(w.alpha, w.ada, row.id);
      expect(row.actualMinutes).toBe(time?.totalMinutes);
    }
  });

  it('is derived at read: an entry deleted is off the next board read', async () => {
    await w.as(w.alpha, w.noah, { command: 'time.delete', entryId: noahEntry });
    expect(actualOf((await rowsOf(w.alpha, w.ada)).rows, 'logged')).toBe(30);
  });
});

describe.skipIf(serverUrl === undefined)('MP-5-8 isolation, actual', () => {
  it('another business: its total never reaches this board, and its member is refused it', async () => {
    const own = await rowsOf(w.alpha, w.ada);
    expect(own.body).not.toContain('"actualMinutes":777');
    expect(own.body).not.toContain(ids['bravo']);
    const foreign = await board(w.alpha, w.bravoOwner);
    expect(isCommandRefusal(foreign) ? foreign.code : 'answered').toBe('AUTH_NO_MEMBERSHIP');
    expect(JSON.stringify(foreign)).not.toMatch(/actualMinutes|canary-/u);
    const theirs = await rowsOf(w.bravo, w.bravoOwner);
    expect(theirs.rows.map((row) => [row.id, row.actualMinutes])).toStrictEqual([
      [ids['bravo'], 777],
    ]);
  });

  it('another client in the same business: a reader of one task is served its total and no other', async () => {
    const { rows, body } = await rowsOf(w.alpha, w.clientA);
    const { time } = await w.timeOf(w.alpha, w.clientA, ids['logged'] ?? '');
    expect(rows.map((row) => [row.id, row.actualMinutes])).toStrictEqual([
      [ids['logged'], time?.totalMinutes],
    ]);
    expect(body).not.toContain('"actualMinutes":555');
    expect(body).not.toContain(ids['other']);
    expect(body).not.toContain(CANARY);
  });
});
