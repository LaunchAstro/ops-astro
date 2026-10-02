// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-8: the Estimates column and the hover door's page read back from the
// task's stored estimate and page link (MP-4-8, MP-4-12), against a real
// database. Each board row carries `estimateMinutes` and `pageLink`, the same
// values `task.read` answers for the task, read at the board read and never a
// stored board field.
//
// Crossings (`MP-5-8 isolation`): another business's estimate and link never
// reach this board and its member is refused it; a reader of one client's
// task is served that task's estimate and link and never another client's.
// The agent under a live delegation is refused the board (mp-5-8-board-agent).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { CANARY, outcomeOf, timeWorld, type TimeWorld } from '../commands/time-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'mp-5-8-board-estimate: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

interface Row {
  readonly id: string;
  readonly estimateMinutes: number | null;
  readonly pageLink: string | null;
}

let w: TimeWorld;
const ids: Record<string, string> = {};
const LINK = '/clients/acme#brief';
const CANARY_LINK = `/${CANARY}`;

const board = async (business: BusinessId, member: Member) =>
  await executeRead(w.db.app, business, member.presented, { read: 'task.board', board: null });

const rowsOf = async (business: BusinessId, member: Member) => {
  const answer = await board(business, member);
  if (isCommandRefusal(answer) || !('tasks' in answer)) {
    throw new Error(`task.board did not answer: ${JSON.stringify(answer)}`);
  }
  return { rows: answer.tasks as unknown as readonly Row[], body: JSON.stringify(answer) };
};

const rowOf = (rows: readonly Row[], name: string) => rows.find((row) => row.id === ids[name]);

const set = async (
  business: BusinessId,
  member: Member,
  task: string,
  fields: Readonly<Record<string, unknown>>,
) => {
  const [row] = await w.db.admin.execute<{ readonly revision: number }>(
    'select revision::int as revision from public.records where id = $1',
    [task],
  );
  const answer = await w.as(business, member, {
    command: 'task.update',
    recordId: task,
    expectedRevision: row?.revision,
    fields,
  });
  expect(outcomeOf(answer)).toStrictEqual({ applied: true });
};

const detailOf = async (business: BusinessId, member: Member, task: string) => {
  const read = await executeRead(w.db.app, business, member.presented, {
    read: 'task.read',
    recordId: task,
  });
  if (isCommandRefusal(read) || !('task' in read)) throw new Error('task.read refused');
  const detail = read.task as unknown as Readonly<Record<string, unknown>>;
  return { estimateMinutes: detail['estimateMinutes'], pageLink: detail['pageLink'] };
};

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('b8e');
  ids['set'] = await w.fresh(w.alpha, w.ada, 'estimated and linked');
  ids['bare'] = await w.fresh(w.alpha, w.ada, 'neither');
  ids['other'] = await w.fresh(w.alpha, w.ada, CANARY);
  ids['bravo'] = await w.fresh(w.bravo, w.bravoOwner, CANARY);
  await set(w.alpha, w.ada, ids['set'], { estimated_minutes: 120, page_link: LINK });
  // Canary estimates: 555 minutes on another client's task, 777 in another business.
  await set(w.alpha, w.ada, ids['other'], { estimated_minutes: 555, page_link: CANARY_LINK });
  await set(w.bravo, w.bravoOwner, ids['bravo'], {
    estimated_minutes: 777,
    page_link: CANARY_LINK,
  });
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, w.clientA, 'read', { kind: 'record', id: ids['set'] ?? '' });
  });
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

describe.skipIf(serverUrl === undefined)('MP-5-8 column read-back, estimate and page', () => {
  it('each row’s estimate and page link are its task read’s, null where none is stored', async () => {
    const { rows } = await rowsOf(w.alpha, w.ada);
    expect(rowOf(rows, 'set')).toMatchObject({ estimateMinutes: 120, pageLink: LINK });
    expect(rowOf(rows, 'bare')).toMatchObject({ estimateMinutes: null, pageLink: null });
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop -- one read per row, compared in turn
      const detail = await detailOf(w.alpha, w.ada, row.id);
      expect({ estimateMinutes: row.estimateMinutes, pageLink: row.pageLink }).toStrictEqual(
        detail,
      );
    }
  });

  it('is read at the board read: a changed estimate and a cleared link are the next read', async () => {
    await set(w.alpha, w.ada, ids['set'] ?? '', { estimated_minutes: 45, page_link: null });
    expect(rowOf((await rowsOf(w.alpha, w.ada)).rows, 'set')).toMatchObject({
      estimateMinutes: 45,
      pageLink: null,
    });
    await set(w.alpha, w.ada, ids['set'] ?? '', { estimated_minutes: 120, page_link: LINK });
  });
});

describe.skipIf(serverUrl === undefined)('MP-5-8 isolation, estimate and page', () => {
  it('another business: its estimate and link never reach this board, and its member is refused it', async () => {
    const own = await rowsOf(w.alpha, w.ada);
    expect(own.body).not.toContain('"estimateMinutes":777');
    expect(own.body).not.toContain(ids['bravo']);
    const foreign = await board(w.alpha, w.bravoOwner);
    expect(isCommandRefusal(foreign) ? foreign.code : 'answered').toBe('AUTH_NO_MEMBERSHIP');
    expect(JSON.stringify(foreign)).not.toMatch(/estimateMinutes|pageLink|canary-/u);
    const theirs = await rowsOf(w.bravo, w.bravoOwner);
    expect(theirs.rows.map((row) => [row.id, row.estimateMinutes, row.pageLink])).toStrictEqual([
      [ids['bravo'], 777, CANARY_LINK],
    ]);
  });

  it('another client in the same business: a reader of one task is served its estimate and link and no other', async () => {
    const { rows, body } = await rowsOf(w.alpha, w.clientA);
    expect(rows.map((row) => [row.id, row.estimateMinutes, row.pageLink])).toStrictEqual([
      [ids['set'], 120, LINK],
    ]);
    expect(body).not.toContain('"estimateMinutes":555');
    expect(body).not.toContain(ids['other']);
    expect(body).not.toContain(CANARY);
  });
});
