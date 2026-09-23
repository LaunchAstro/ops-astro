// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.board` on a board that is not the caller's: refused, never empty.
//
// A board is a task record, and `task.move` already refuses a board that is
// not alpha's `NOT_FOUND` (`commands/tasks-place.ts`). The read took the same
// identifier and answered `{ ok: true, tasks: [] }`, which is the answer
// minimum contract 8.2 rules out twice: case 1 asks `NOT_FOUND` for another
// business's identifier, and case 3 says a denied list is never an empty
// success. So a foreign board, a fabricated one and a malformed one are each
// refused with the same body, and alpha's own audit records the refusal with
// no subject, because the identifier resolved to nothing alpha holds. An own
// board and `null`, the list of tasks on no board, still list.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';

const serverUrl = databaseUrlFromEnvironment();

type Command = Parameters<typeof executeCommand>[4];

describe.skipIf(serverUrl === undefined)('task.board on a board that is not here', () => {
  let db: FreshDatabase;
  let alpha: string;
  let bravo: string;
  let ada: Member;
  let bea: Member;
  let alphaBoard: string;
  let bravoBoard: string;

  const make = async (business: string, who: Member, title: string) => {
    const made = await executeCommand(db.app, business, who.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title },
    } as Command);
    if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
    return { recordId: made.recordId ?? '', revision: made.revision ?? 0 };
  };

  const create = async (business: string, who: Member, title: string): Promise<string> =>
    (await make(business, who, title)).recordId;

  const board = async (id: string | null) =>
    await executeRead(db.app, alpha, ada.presented, { read: 'task.board', board: id });

  const boardAudit = async (business: string) =>
    await db.app.withBusiness(business, async (tx) =>
      (await readAuditEvents(tx)).filter((event) => event.command === 'task.board'),
    );

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'b' });
    alpha = await insertBusiness(db.app, 'alpha');
    bravo = await insertBusiness(db.app, 'bravo');
    await installSpine(db.app, alpha);
    await installSpine(db.app, bravo);
    ada = await enrol(db.app, alpha, 'ada');
    bea = await enrol(db.app, bravo, 'bea');
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, ada, 'read');
      await grantTo(tx, ada, 'write');
    });
    await db.app.withBusiness(bravo, async (tx) => {
      await grantTo(tx, bea, 'read');
      await grantTo(tx, bea, 'write');
    });
    alphaBoard = await create(alpha, ada, 'alpha board');
    bravoBoard = await create(bravo, bea, 'bravo board');
    const onBoard = await make(alpha, ada, 'on the alpha board');
    const placed = await executeCommand(db.app, alpha, ada.presented, 'api', {
      command: 'task.move',
      operationId: randomUUID(),
      recordId: onBoard.recordId,
      expectedRevision: onBoard.revision,
      board: alphaBoard,
      boardSection: null,
    } as Command);
    if (isCommandRefusal(placed)) throw new Error(`task.move refused ${placed.code}`);
  }, 60_000);

  afterAll(async () => await db?.drop());

  it('refuses a foreign, a fabricated and a malformed board alike, NOT_FOUND', async () => {
    const before = (await boardAudit(alpha)).length;
    const answers = [
      await board(bravoBoard),
      await board(randomUUID()),
      await board('not-a-board'),
    ];
    for (const answer of answers) {
      expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('NOT_FOUND');
      expect(answer).toStrictEqual(answers[0]);
      expect(JSON.stringify(answer).includes(bravoBoard)).toBe(false);
    }

    const events = (await boardAudit(alpha)).slice(before);
    expect(events.map((event) => [event.outcome, event.refusal_code])).toStrictEqual([
      ['refused', 'NOT_FOUND'],
      ['refused', 'NOT_FOUND'],
      ['refused', 'NOT_FOUND'],
    ]);
    expect(events.map((event) => event.subject_record_id)).toStrictEqual([null, null, null]);
    // The probe's trail is alpha's; bravo is not told it was probed (8.2 case 1).
    expect(await boardAudit(bravo)).toStrictEqual([]);
  });

  it('refuses a board alpha trashed, like one it never had', async () => {
    const gone = await make(alpha, ada, 'a board that goes');
    const trashed = await executeCommand(db.app, alpha, ada.presented, 'api', {
      command: 'task.trash',
      operationId: randomUUID(),
      recordId: gone.recordId,
      expectedRevision: gone.revision,
    } as Command);
    if (isCommandRefusal(trashed)) throw new Error(`task.trash refused ${trashed.code}`);
    const answer = await board(gone.recordId);
    expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('NOT_FOUND');
  });

  it("lists alpha's own board", async () => {
    const answer = await board(alphaBoard);
    expect('tasks' in answer ? answer.tasks.map((task) => task.title) : answer).toStrictEqual([
      'on the alpha board',
    ]);
  });

  it('lists the tasks on no board for null', async () => {
    const answer = await board(null);
    expect('tasks' in answer).toBe(true);
    const titles = 'tasks' in answer ? answer.tasks.map((task) => task.title) : [];
    expect(titles).toContain('alpha board');
    expect(titles).not.toContain('on the alpha board');
  });
});
