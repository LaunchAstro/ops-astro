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
//
// On this branch the marks (`task.set_scores`) and the rank on `task.read`
// are SL08's U15 (MP-4-9, MP-4-2), not yet on main, so these cases are held
// until it lands (LEANS-ON; comments, not todo, since the isolation manifest
// refuses a skip):
// - every row carries the rank, stage and client mark its task read answers
// - draws the rank's number, score and calc line where marks are stored
// - is never stored: a mark changed is the next board read’s number
// - another business: its higher score never moves an Alpha number
// - another client in the same business: a reader of client A’s two tasks ranks them #1 and #2

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
    'mp-5-8-board-columns: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Body = Readonly<Record<string, unknown>>;

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
  extra: { readonly client?: string; readonly stage?: string } = {},
) => {
  const made = await command(business, by, { command: 'task.create', fields: { title } });
  const recordId = made.recordId ?? '';
  if (extra.client !== undefined) {
    await change(business, by, recordId, {
      command: 'task.set_party',
      fields: { client: extra.client },
    });
  }
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
  await make(alpha, owner, 'a504', 'client A work', { client: clientA, stage: 'Build' });
  await make(alpha, owner, 'b900', CANARY, { client: clientB, stage: CANARY });
  await make(alpha, owner, 'a630', 'second', { client: clientA });
  await make(alpha, owner, 'unscored', 'no ease yet');
  // Bravo: a task that outscores everything in Alpha.
  await make(bravo, bravoOwner, 'bravo', CANARY);
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
  it('draws a real value where one is stored and null only where none is', async () => {
    const byId = new Map((await rowsOf(w.alpha, w.owner)).map((row) => [row.id, row]));
    const a504 = byId.get(idOf('a504'));
    expect([a504?.stage, a504?.clientSet]).toStrictEqual(['Build', true]);
    const unscored = byId.get(idOf('unscored'));
    expect([unscored?.stage, unscored?.clientSet]).toStrictEqual([null, false]);
  });
});

describe.skipIf(serverUrl === undefined)('MP-5-8 isolation', () => {
  it('another business: never reaches the board', async () => {
    const answer = await board(w.alpha, w.owner);
    expect(JSON.stringify(answer)).not.toContain(idOf('bravo'));
    const own = await rowsOf(w.bravo, w.bravoOwner);
    expect(own.map((row) => row.id)).toStrictEqual([idOf('bravo')]);
    const crossing = await board(w.alpha, w.bravoOwner);
    expect(isCommandRefusal(crossing) ? crossing.code : 'answered').not.toBe('answered');
    expect(JSON.stringify(crossing)).not.toContain(CANARY);
  });

  it('another client in the same business: a reader of client A’s two tasks is served those two', async () => {
    const answer = await board(w.alpha, w.pairViewer);
    expect(isCommandRefusal(answer)).toBe(false);
    const rows = await rowsOf(w.alpha, w.pairViewer);
    expect(rows.map((row) => row.id).toSorted()).toStrictEqual(
      [idOf('a504'), idOf('a630')].toSorted(),
    );
    const text = JSON.stringify(answer);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(idOf('b900'));
    expect(text).not.toContain(idOf('unscored'));
  });

  it('a member with no grant is refused and shown no rank or stage', async () => {
    const refused = await board(w.alpha, w.nobody);
    expect(isCommandRefusal(refused) ? refused.code : 'answered').toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(refused)).not.toMatch(/"rank"|"stage"|Build/u);
    expect(JSON.stringify(refused)).not.toContain(CANARY);
  });
});
