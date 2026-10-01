// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-8: the Projects board's columns read back from stored records, against
// a real database.
//
// Each board row carries what its cells draw: the rank and its calc line
// (derived by MP-4-9 at read, never stored), the stage and the client mark,
// beside the assignee and due the summary already had. Every value is read
// back against the task's own read, so the board and the task page cannot
// disagree (`MP-5-8 column read-back`). The rank's pool is the open tasks the
// reader's grants reach, the same pool `task.read` uses, taken from the one
// grant read that admits the board: a task the reader cannot see never moves
// a number on it (`MP-5-8 isolation`). Each crossing plants a canary title on
// the task the reader may not see and reads every body for it.

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
import { clientHere } from './client-rows.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'mp-5-8-board-columns: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Body = Readonly<Record<string, unknown>>;
type Marks = readonly [number | null, number | null, number | null];

interface BoardRow {
  readonly id: string;
  readonly rank: {
    readonly number: number | null;
    readonly score: number | null;
    readonly calc: string;
  };
  readonly stage: string | null;
  readonly clientSet: boolean;
  readonly assignee: { readonly personId: string } | null;
  readonly due: string | null;
}

const CANARY = `canary-${randomUUID()}`;

interface World {
  readonly db: FreshDatabase;
  readonly alpha: BusinessId;
  readonly bravo: BusinessId;
  readonly owner: Member;
  readonly bravoOwner: Member;
  readonly pairViewer: Member;
  readonly nobody: Member;
  readonly ids: Record<string, string>;
}

let w: World;

const idOf = (name: string): string => w.ids[name] ?? '';

const command = async (business: BusinessId, member: Member, body: Body) => {
  const answer = await executeCommand(w.db.app, business, member.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);
  if (isCommandRefusal(answer))
    throw new Error(`${String(body['command'])} refused ${answer.code}`);
  return answer;
};

const revisionOf = async (recordId: string) =>
  Number(
    (
      await w.db.admin.execute<{ readonly revision: string }>(
        `select revision::text as revision from public.records where id = $1`,
        [recordId],
      )
    )[0]?.revision,
  );

const change = async (business: BusinessId, by: Member, recordId: string, body: Body) =>
  await command(business, by, { ...body, recordId, expectedRevision: await revisionOf(recordId) });

const make = async (
  business: BusinessId,
  by: Member,
  name: string,
  title: string,
  marks: Marks,
  extra: { readonly client?: string; readonly stage?: string } = {},
) => {
  const made = await command(business, by, { command: 'task.create', fields: { title } });
  const recordId = made.recordId ?? '';
  // The client first: once the task holds content its client is locked (S0-5).
  if (extra.client !== undefined) {
    await change(business, by, recordId, {
      command: 'task.set_party',
      fields: { client: await clientHere(w.db.admin, business, extra.client) },
    });
  }
  const [impact, confidence, ease] = marks;
  await change(business, by, recordId, {
    command: 'task.set_scores',
    fields: { impact, confidence, ease },
  });
  if (extra.stage !== undefined) {
    await change(business, by, recordId, {
      command: 'task.set_stage',
      fields: { stage: extra.stage },
    });
  }
  w.ids[name] = recordId;
};

const board = async (business: BusinessId, member: Member) =>
  await executeRead(w.db.app, business, member.presented, { read: 'task.board', board: null });

const rowsOf = async (business: BusinessId, member: Member): Promise<readonly BoardRow[]> => {
  const answer = await board(business, member);
  if (isCommandRefusal(answer) || !('tasks' in answer)) {
    throw new Error(`task.board did not answer: ${JSON.stringify(answer)}`);
  }
  return answer.tasks as unknown as readonly BoardRow[];
};

const numbers = (rows: readonly BoardRow[]) =>
  Object.fromEntries(rows.map((row) => [row.id, row.rank.number]));

async function open(): Promise<World> {
  const db = await createFreshDatabase({ part: 'b8' });
  const alpha = (await insertBusiness(db.app, 'mp58-alpha')) as BusinessId;
  const bravo = (await insertBusiness(db.app, 'mp58-bravo')) as BusinessId;
  await installSpine(db.app, alpha);
  await installSpine(db.app, bravo);
  const world: World = {
    db,
    alpha,
    bravo,
    owner: await enrol(db.app, alpha, 'owner'),
    bravoOwner: await enrol(db.app, bravo, 'bravo-owner'),
    pairViewer: await enrol(db.app, alpha, 'pair-viewer'),
    nobody: await enrol(db.app, alpha, 'nobody'),
    ids: {},
  };
  await db.app.withBusiness(alpha, async (tx) => {
    // `share` only so each task can be put under its client (`task.set_party`).
    for (const action of ['read', 'write', 'share'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, world.owner, action);
    }
  });
  await db.app.withBusiness(bravo, async (tx) => {
    for (const action of ['read', 'write'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, world.bravoOwner, action);
    }
  });
  return world;
}

async function plant(): Promise<void> {
  const { alpha, bravo, owner, bravoOwner, pairViewer } = w;
  const clientA = randomUUID();
  const clientB = randomUUID();
  // Alpha: 504 and 630 for client A, 900 for client B (the canary), one unscored.
  await make(alpha, owner, 'a504', 'client A work', [7, 9, 8], { client: clientA, stage: 'Build' });
  await make(alpha, owner, 'b900', CANARY, [10, 10, 9], { client: clientB, stage: CANARY });
  await make(alpha, owner, 'a630', 'second', [7, 9, 10], { client: clientA });
  await make(alpha, owner, 'unscored', 'no ease yet', [5, 7, null]);
  // Bravo: a task that outscores everything in Alpha.
  await make(bravo, bravoOwner, 'bravo', CANARY, [10, 10, 10]);
  await w.db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, pairViewer, 'read', { kind: 'record', id: idOf('a504') });
    await grantTo(tx, pairViewer, 'read', { kind: 'record', id: idOf('a630') });
  });
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await open();
  await plant();
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

describe.skipIf(serverUrl === undefined)('MP-5-8 column read-back', () => {
  it('every row carries the rank, stage and client mark its task read answers', async () => {
    const rows = await rowsOf(w.alpha, w.owner);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop -- one read per row, compared in turn
      const read = await executeRead(w.db.app, w.alpha, w.owner.presented, {
        read: 'task.read',
        recordId: row.id,
      });
      if (isCommandRefusal(read) || !('task' in read)) throw new Error('task.read refused');
      const task = read.task as unknown as BoardRow;
      expect([row.rank, row.stage, row.clientSet, row.due]).toStrictEqual([
        task.rank,
        task.stage,
        task.clientSet,
        task.due,
      ]);
    }
  });

  it('draws a real value where one is stored and null only where none is', async () => {
    const byId = new Map((await rowsOf(w.alpha, w.owner)).map((row) => [row.id, row]));
    const a504 = byId.get(idOf('a504'));
    expect([a504?.rank.number, a504?.rank.score, a504?.stage, a504?.clientSet]).toStrictEqual([
      3,
      504,
      'Build',
      true,
    ]);
    expect(a504?.rank.calc).toBe(
      'impact 7 × confidence 9 × ease 8 × priority 1 × age 1 = 504 · derived',
    );
    const unscored = byId.get(idOf('unscored'));
    expect([
      unscored?.rank.number,
      unscored?.rank.calc,
      unscored?.stage,
      unscored?.clientSet,
    ]).toStrictEqual([null, 'not ranked: missing ease', null, false]);
  });
});

describe.skipIf(serverUrl === undefined)('MP-5-8 column read-back, derived at read', () => {
  it('is never stored: a mark changed is the next board read’s number', async () => {
    const recordId = idOf('a504');
    await change(w.alpha, w.owner, recordId, {
      command: 'task.set_scores',
      fields: { impact: 10, confidence: 10, ease: 10 },
    });
    expect(numbers(await rowsOf(w.alpha, w.owner))[recordId]).toBe(1);
    await change(w.alpha, w.owner, recordId, {
      command: 'task.set_scores',
      fields: { impact: 7, confidence: 9, ease: 8 },
    });
    expect(numbers(await rowsOf(w.alpha, w.owner))[recordId]).toBe(3);
  });
});

describe.skipIf(serverUrl === undefined)('MP-5-8 isolation', () => {
  it('another business: its higher score never moves an Alpha number, and never reaches the board', async () => {
    const answer = await board(w.alpha, w.owner);
    expect(numbers(await rowsOf(w.alpha, w.owner))[idOf('b900')]).toBe(1);
    expect(JSON.stringify(answer)).not.toContain(idOf('bravo'));
    const own = await rowsOf(w.bravo, w.bravoOwner);
    expect(own.map((row) => [row.id, row.rank.number])).toStrictEqual([[idOf('bravo'), 1]]);
    const crossing = await board(w.alpha, w.bravoOwner);
    expect(isCommandRefusal(crossing) ? crossing.code : 'answered').not.toBe('answered');
    expect(JSON.stringify(crossing)).not.toContain(CANARY);
  });

  it('another client in the same business: a reader of client A’s two tasks ranks them #1 and #2', async () => {
    const answer = await board(w.alpha, w.pairViewer);
    expect(isCommandRefusal(answer)).toBe(false);
    const rows = await rowsOf(w.alpha, w.pairViewer);
    expect(numbers(rows)).toStrictEqual({ [idOf('a630')]: 1, [idOf('a504')]: 2 });
    const text = JSON.stringify(answer);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(idOf('b900'));
    expect(text).not.toContain(idOf('unscored'));
    for (const row of rows) expect(row.rank.calc).not.toContain('900');
  });

  it('a member with no grant is refused and shown no rank or stage', async () => {
    const refused = await board(w.alpha, w.nobody);
    expect(isCommandRefusal(refused) ? refused.code : 'answered').toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(refused)).not.toMatch(/"rank"|"stage"|Build/u);
    expect(JSON.stringify(refused)).not.toContain(CANARY);
  });
});
