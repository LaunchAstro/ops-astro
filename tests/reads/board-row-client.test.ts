// SPDX-License-Identifier: AGPL-3.0-only
//
// The Clients row door (DOCK.md section 2): a client's door opens the Projects
// board filtered to that client, so each board row carries its client by id
// and name, against a real database.
//
// The rule is `task.read`'s and `client.list`'s (C32, CS-4.12): the client goes
// only to a reader whose live grants reach it (a grant over the business, or one
// on the client). A reader who holds the task but not its client reads null
// beside `clientSet: true`, the answer `task.read` gives, and never the id or
// name `client.list` withholds. Each crossing plants a canary as the withheld
// client's name and reads every body for it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { agentWorld, codeOf } from '../commands/agent-fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { clientHere } from './client-rows.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'board-row-client: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Body = Readonly<Record<string, unknown>>;

interface BoardRow {
  readonly id: string;
  readonly clientSet: boolean;
  readonly client?: { readonly clientId: string; readonly name: string } | null;
}

const CANARY = `canary-${randomUUID()}`;
const CLIENT_A = randomUUID();
const CLIENT_B = randomUUID();

interface World {
  readonly db: FreshDatabase;
  readonly alpha: BusinessId;
  readonly bravo: BusinessId;
  readonly owner: Member;
  readonly bravoOwner: Member;
  /** Reads client A's work through a grant on client A. */
  readonly clientReader: Member;
  /** Holds B's task by a record grant, and no grant on client B. */
  readonly taskHolder: Member;
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

const make = async (business: BusinessId, by: Member, name: string, client?: string) => {
  const made = await command(business, by, { command: 'task.create', fields: { title: name } });
  const recordId = made.recordId ?? '';
  if (client !== undefined) {
    await command(business, by, {
      command: 'task.set_party',
      recordId,
      expectedRevision: 1,
      fields: { client: await clientHere(w.db.admin, business, client) },
    });
  }
  w.ids[name] = recordId;
};

const read = async (business: BusinessId, member: Member, body: Body) =>
  await executeRead(w.db.app, business, member.presented, body as never);

const rowsOf = async (business: BusinessId, member: Member) => {
  const answer = await read(business, member, { read: 'task.board', board: null });
  if (isCommandRefusal(answer) || !('tasks' in answer)) {
    throw new Error(`task.board did not answer: ${JSON.stringify(answer)}`);
  }
  return { rows: answer.tasks as unknown as readonly BoardRow[], text: JSON.stringify(answer) };
};

const rowOf = (rows: readonly BoardRow[], name: string): BoardRow | undefined =>
  rows.find((row) => row.id === idOf(name));

async function open(): Promise<World> {
  const db = await createFreshDatabase({ part: 'b8' });
  const alpha = (await insertBusiness(db.app, 'door-alpha')) as BusinessId;
  const bravo = (await insertBusiness(db.app, 'door-bravo')) as BusinessId;
  await installSpine(db.app, alpha);
  await installSpine(db.app, bravo);
  const world: World = {
    db,
    alpha,
    bravo,
    owner: await enrol(db.app, alpha, 'owner'),
    bravoOwner: await enrol(db.app, bravo, 'bravo-owner'),
    clientReader: await enrol(db.app, alpha, 'client-reader'),
    taskHolder: await enrol(db.app, alpha, 'task-holder'),
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
  const { alpha, bravo, owner, bravoOwner, clientReader, taskHolder } = w;
  await make(alpha, owner, 'a-work', CLIENT_A);
  await make(alpha, owner, 'b-work', CLIENT_B);
  await make(alpha, owner, 'no-client');
  await make(bravo, bravoOwner, 'bravo-work');
  // Client B is named by the canary: no body that withholds B may carry it.
  await w.db.admin.execute(`update public.clients set name = $1 where id = $2`, [CANARY, CLIENT_B]);
  await w.db.admin.execute(`update public.clients set name = 'Harbour Physio' where id = $1`, [
    CLIENT_A,
  ]);
  await w.db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, clientReader, 'read', { kind: 'party', id: CLIENT_A });
    await grantTo(tx, taskHolder, 'read', { kind: 'record', id: idOf('b-work') });
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

describe.skipIf(serverUrl === undefined)('Clients row door: the board row client', () => {
  it('each row carries its client by id and name, as task.read and client.list answer them', async () => {
    const { rows } = await rowsOf(w.alpha, w.owner);
    expect(rowOf(rows, 'a-work')?.client).toEqual({ clientId: CLIENT_A, name: 'Harbour Physio' });
    expect(rowOf(rows, 'b-work')?.client).toEqual({ clientId: CLIENT_B, name: CANARY });
    expect(rowOf(rows, 'no-client')?.client).toBeNull();
    const detail = await read(w.alpha, w.owner, { read: 'task.read', recordId: idOf('a-work') });
    expect(JSON.stringify(detail)).toContain(`"client":"${CLIENT_A}"`);
    const listed = await read(w.alpha, w.owner, { read: 'client.list' });
    expect(JSON.stringify(listed)).toContain('"name":"Harbour Physio"');
  });
});

describe.skipIf(serverUrl === undefined)('Clients row door isolation', () => {
  it('another business: its board names none of alpha’s clients, by id or name', async () => {
    const { rows, text } = await rowsOf(w.bravo, w.bravoOwner);
    expect(rows.map((row) => row.client ?? null)).toEqual([null]);
    for (const withheld of [CANARY, CLIENT_A, CLIENT_B, 'Harbour Physio', idOf('a-work')]) {
      expect(text).not.toContain(withheld);
    }
  });

  it('another client: a reader of client A’s work is sent A, never B’s id, name or task', async () => {
    const { rows, text } = await rowsOf(w.alpha, w.clientReader);
    expect(rows.map((row) => row.id)).toEqual([idOf('a-work')]);
    expect(rows[0]?.client).toEqual({ clientId: CLIENT_A, name: 'Harbour Physio' });
    for (const withheld of [CANARY, CLIENT_B, idOf('b-work')]) expect(text).not.toContain(withheld);
  });

  it('another person: holding B’s task without client B reads null beside clientSet', async () => {
    const { rows, text } = await rowsOf(w.alpha, w.taskHolder);
    expect(rows.map((row) => [row.id, row.clientSet, row.client])).toEqual([
      [idOf('b-work'), true, null],
    ]);
    for (const withheld of [CANARY, CLIENT_B, CLIENT_A]) expect(text).not.toContain(withheld);
  });

  it('an agent under a live delegation is refused the board, no client id or name', async () => {
    const world = await agentWorld('b8', `door-agent-${randomUUID().slice(0, 8)}`);
    try {
      const decider = await world.decider('decider');
      const picked = await world.pickUp(decider, 'the agent’s task');
      const answer = await world.asAgent(
        { command: 'task.board', operationId: randomUUID(), board: null },
        picked.credential,
      );
      expect(codeOf(answer)).toBe('DELEGATION_EXCLUDES_OPERATION');
      expect(JSON.stringify(answer)).not.toMatch(/"clientId"|"client":\{/u);
    } finally {
      await world.drop();
    }
  }, 180_000);
});
