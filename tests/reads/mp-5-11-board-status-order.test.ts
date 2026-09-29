// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-11: the Projects board groups its rows by status in the workflow's
// status order, against a real database.
//
// The order is the stored state records' own `position`, the workflow's
// vocabulary as installed (Needs review, Active, Waiting on client, On hold,
// Complete), never the order the rows happen to arrive in. Each board row
// carries its state's position beside the state, read from the same state
// record, so a reordered workflow is the next read's order
// (`MP-5-11 groups in the status vocabulary's order`). The position a row
// carries is its own business's: another business reordering its workflow
// never moves a row here, and a reader who cannot read a task is shown no
// position of it (`MP-5-11 isolation`; the agent's crossing is in
// mp-5-11-board-agent).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'mp-5-11-board-status-order: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Body = Readonly<Record<string, unknown>>;

interface BoardRow {
  readonly id: string;
  readonly state: { readonly id: string; readonly key: string; readonly label: string } | null;
  readonly statePosition: number | null;
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

const make = async (
  business: BusinessId,
  by: Member,
  name: string,
  title: string,
  then: readonly string[] = [],
  client?: string,
) => {
  const made = await command(business, by, { command: 'task.create', fields: { title } });
  const recordId = made.recordId ?? '';
  const steps: Body[] = [
    ...(client === undefined ? [] : [{ command: 'task.set_party', fields: { client } }]),
    ...then.map((step) => ({ command: step })),
  ];
  for (const step of steps) {
    // eslint-disable-next-line no-await-in-loop -- each step reads the revision the last one wrote
    const expectedRevision = await revisionOf(recordId);
    // eslint-disable-next-line no-await-in-loop -- one command at a time, in order
    await command(business, by, { ...step, recordId, expectedRevision });
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

/** The stored position of a business's state, by its key. */
const storedPosition = async (business: BusinessId, key: string) =>
  Number(
    (
      await w.db.admin.execute<{ readonly position: string }>(
        `select s.data ->> 'position' as position
           from public.records s join public.record_types t on t.id = s.record_type_id
          where s.business_id = $1 and t.key = 'task_state' and s.data ->> 'key' = $2`,
        [business, key],
      )
    )[0]?.position,
  );

/** Moves a business's state to a new position, as a preset sync would. */
const reposition = async (business: BusinessId, key: string, position: number) => {
  await w.db.admin.execute(
    `update public.records s set data = jsonb_set(s.data, '{position}', to_jsonb($3::numeric))
       from public.record_types t
      where t.id = s.record_type_id and s.business_id = $1 and t.key = 'task_state'
        and s.data ->> 'key' = $2`,
    [business, key, position],
  );
};

async function open(): Promise<World> {
  const db = await createFreshDatabase({ part: 'b8' });
  const alpha = (await insertBusiness(db.app, 'mp511-alpha')) as BusinessId;
  const bravo = (await insertBusiness(db.app, 'mp511-bravo')) as BusinessId;
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
  // Created in the reverse of the workflow's order, so first-seen is wrong.
  await make(alpha, owner, 'done', 'finished', ['task.start', 'task.complete'], clientA);
  await make(alpha, owner, 'going', 'under way', ['task.start'], clientA);
  await make(alpha, owner, 'fresh', 'just in');
  await make(alpha, owner, 'other', CANARY, ['task.start'], clientB);
  await make(bravo, bravoOwner, 'bravo', CANARY, ['task.start', 'task.complete']);
  await w.db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, pairViewer, 'read', { kind: 'record', id: idOf('done') });
    await grantTo(tx, pairViewer, 'read', { kind: 'record', id: idOf('going') });
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

describe.skipIf(serverUrl === undefined)("MP-5-11 groups in the status vocabulary's order", () => {
  it('every row carries its state’s stored position, read from the same state record', async () => {
    const rows = await rowsOf(w.alpha, w.owner);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const key = row.state?.key ?? '';
      // eslint-disable-next-line no-await-in-loop -- one stored position per row, compared in turn
      expect(row.statePosition).toBe(await storedPosition(w.alpha, key));
    }
  });

  it('orders the states as the workflow does, not as the rows arrived', async () => {
    const byId = new Map((await rowsOf(w.alpha, w.owner)).map((row) => [row.id, row]));
    const position = (name: string) => byId.get(idOf(name))?.statePosition ?? Number.NaN;
    expect(position('going')).toBeLessThan(position('done'));
    expect(byId.get(idOf('going'))?.state?.label).toBe('Active');
    expect(byId.get(idOf('done'))?.state?.label).toBe('Complete');
  });

  it('is read, never kept: a reordered workflow is the next read’s order', async () => {
    const before = await storedPosition(w.alpha, 'complete');
    await reposition(w.alpha, 'complete', 10);
    try {
      const byId = new Map((await rowsOf(w.alpha, w.owner)).map((row) => [row.id, row]));
      expect(byId.get(idOf('done'))?.statePosition).toBe(10);
      expect(byId.get(idOf('going'))?.statePosition).toBe(await storedPosition(w.alpha, 'active'));
    } finally {
      await reposition(w.alpha, 'complete', before);
    }
  });
});

describe.skipIf(serverUrl === undefined)('MP-5-11 isolation', () => {
  it('another business: its reordered workflow never moves a row here, and never reaches the board', async () => {
    const before = await storedPosition(w.bravo, 'complete');
    await reposition(w.bravo, 'complete', 1);
    try {
      const answer = await board(w.alpha, w.owner);
      const done = (await rowsOf(w.alpha, w.owner)).find((row) => row.id === idOf('done'));
      expect(done?.statePosition).toBe(await storedPosition(w.alpha, 'complete'));
      expect(done?.statePosition).not.toBe(1);
      expect(JSON.stringify(answer)).not.toContain(idOf('bravo'));
      const own = await rowsOf(w.bravo, w.bravoOwner);
      expect(own.map((row) => [row.id, row.statePosition])).toStrictEqual([[idOf('bravo'), 1]]);
      const crossing = await board(w.alpha, w.bravoOwner);
      expect(isCommandRefusal(crossing) ? crossing.code : 'answered').not.toBe('answered');
      expect(JSON.stringify(crossing)).not.toContain(CANARY);
    } finally {
      await reposition(w.bravo, 'complete', before);
    }
  });

  it('another client in the same business: a reader of client A’s two tasks gets only their positions', async () => {
    const answer = await board(w.alpha, w.pairViewer);
    const rows = await rowsOf(w.alpha, w.pairViewer);
    expect(rows.map((row) => row.id).toSorted()).toStrictEqual(
      [idOf('done'), idOf('going')].toSorted(),
    );
    for (const row of rows) expect(typeof row.statePosition).toBe('number');
    const text = JSON.stringify(answer);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(idOf('other'));
    expect(text).not.toContain(idOf('fresh'));
  });

  it('a member with no grant is refused and shown no state or position', async () => {
    const refused = await board(w.alpha, w.nobody);
    expect(isCommandRefusal(refused) ? refused.code : 'answered').toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(refused)).not.toMatch(/"statePosition"|"state"|Complete/u);
    expect(JSON.stringify(refused)).not.toContain(CANARY);
  });
});
