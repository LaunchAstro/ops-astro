// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-8: a board row's rank is the rank its task read answers, for the one
// kind of task whose openness is not its state: a step its parent's
// completion archived (MP-4-15). Such a step is not open work, so it takes no
// number on the task page, and the board must say the same while its parent
// is done and give it back its number when the parent is reopened.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'mp-5-8-board-rank-steps: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Body = Readonly<Record<string, unknown>>;
interface Rank {
  readonly number: number | null;
  readonly score: number | null;
  readonly calc: string;
}

let db: FreshDatabase;
let alpha: BusinessId;
let owner: Member;

const command = async (body: Body) => {
  const answer = await executeCommand(db.app, alpha, owner.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);
  if (isCommandRefusal(answer))
    throw new Error(`${String(body['command'])} refused ${answer.code}`);
  return answer;
};

const change = async (recordId: string, body: Body) => {
  const rows = await db.admin.execute<{ readonly revision: string }>(
    `select revision::text as revision from public.records where id = $1`,
    [recordId],
  );
  return await command({ ...body, recordId, expectedRevision: Number(rows[0]?.revision) });
};

const scored = async (title: string, parentId?: string) => {
  const made = await command({ command: 'task.create', fields: { title }, parentId });
  const recordId = made.recordId ?? '';
  await change(recordId, {
    command: 'task.set_scores',
    fields: { impact: 9, confidence: 9, ease: 9 },
  });
  return recordId;
};

/** The step's rank on the board and on its own read, side by side. */
const bothRanks = async (recordId: string): Promise<readonly [Rank | undefined, Rank]> => {
  const board = await executeRead(db.app, alpha, owner.presented, {
    read: 'task.board',
    board: null,
  });
  if (isCommandRefusal(board) || !('tasks' in board)) throw new Error('task.board refused');
  const rows = board.tasks as unknown as readonly { readonly id: string; readonly rank: Rank }[];
  const read = await executeRead(db.app, alpha, owner.presented, { read: 'task.read', recordId });
  if (isCommandRefusal(read) || !('task' in read)) throw new Error('task.read refused');
  return [
    rows.find((row) => row.id === recordId)?.rank,
    (read.task as unknown as { rank: Rank }).rank,
  ];
};

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'b8s' });
  alpha = (await insertBusiness(db.app, 'mp58-steps')) as BusinessId;
  await installSpine(db.app, alpha);
  owner = await enrol(db.app, alpha, 'owner');
  await db.app.withBusiness(alpha, async (tx) => {
    for (const action of ['read', 'write'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, owner, action);
    }
  });
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

describe.skipIf(serverUrl === undefined)('MP-5-8 column read-back, archived steps', () => {
  it('a step its parent’s completion archived takes no number, as its task read answers', async () => {
    const parent = await scored('parent');
    const step = await scored('step', parent);
    const [before, beforeRead] = await bothRanks(step);
    expect(before?.number).not.toBeNull();
    expect(before).toStrictEqual(beforeRead);

    await change(parent, { command: 'task.complete' });
    const [archived, archivedRead] = await bothRanks(step);
    expect(archived?.number).toBeNull();
    expect(archived).toStrictEqual(archivedRead);

    await change(parent, { command: 'task.reopen', reason: 'More to do' });
    const [back, backRead] = await bothRanks(step);
    expect(back?.number).not.toBeNull();
    expect(back).toStrictEqual(backRead);
  });
});
