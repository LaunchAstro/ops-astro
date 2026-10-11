// SPDX-License-Identifier: AGPL-3.0-only
//
// Assign to AI on the board (agent assignee ruling point 9): each row of
// `task.board` carries what `task.read` carries for the same task and reader,
// `agent` (the agent holding it, by name with its owner, shown to every person
// who reads the row) and `myAgents` (the agents the reader may direct: their
// own, or every one with `agent:assign`). Real crossings, statuses checked:
// another person, another client in the same business, another business; and
// an agent, which never reads the board.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import {
  CANARY,
  aiWorld,
  assign,
  created,
  minted,
  ownedAgent,
  type AiWorld,
} from '../commands/ai-assign-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('board-agents: DATABASE_URL is unset.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('aiboard');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

interface Row {
  readonly id: string;
  readonly agent?: { readonly agentId: string; readonly name: string } | null;
  readonly myAgents?: readonly { readonly agentId: string }[];
}

const board = async (
  business: BusinessId,
  by: Member,
): Promise<{ readonly text: string; readonly rows: readonly Row[] }> => {
  const answer = await executeRead(w.world.db.app, business, by.presented, {
    read: 'task.board',
    board: null,
  });
  const text = JSON.stringify(answer);
  if (isCommandRefusal(answer)) return { text, rows: [] };
  return { text, rows: (answer as unknown as { readonly tasks: readonly Row[] }).tasks };
};

const rowOf = (rows: readonly Row[], id: string): Row | undefined =>
  rows.find((row) => row.id === id);

const offers = (row: Row | undefined): readonly string[] =>
  (row?.myAgents ?? []).map((one) => one.agentId);

describe.skipIf(serverUrl === undefined)('Assign to AI on the board', () => {
  it('a row shows the agent holding it by name, and every row offers the reader’s own agents', async () => {
    const held = await created(w, w.p, 'held by my agent');
    const open = await created(w, w.p, 'my agent may take it');
    const holding = await ownedAgent(w, w.p, 'Holding agent');
    const spare = await ownedAgent(w, w.p, 'Spare agent');
    expect(codeOf(await assign(w, w.p, held, { agent: holding }))).toBe('not-a-refusal');

    const { rows } = await board(w.world.business, w.p);
    expect(rowOf(rows, held)?.agent).toMatchObject({ agentId: holding, name: 'Holding agent' });
    expect(offers(rowOf(rows, held))).toEqual(expect.arrayContaining([holding, spare]));
    expect(rowOf(rows, open)?.agent).toBeNull();
    expect(offers(rowOf(rows, open))).toEqual(expect.arrayContaining([holding, spare]));
  });
});

describe.skipIf(serverUrl === undefined)('Assign to AI on the board: person to person', () => {
  it('person to person: P sees Q’s agent holding a row, and is offered none of Q’s agents', async () => {
    const task = await created(w, w.q, 'Q’s row');
    const agent = await ownedAgent(w, w.q, 'Q agent');
    const spare = await ownedAgent(w, w.q, 'Q spare');
    expect(codeOf(await assign(w, w.q, task, { agent }))).toBe('not-a-refusal');

    const { rows } = await board(w.world.business, w.p);
    expect(rowOf(rows, task)?.agent).toMatchObject({ agentId: agent, name: 'Q agent' });
    expect(offers(rowOf(rows, task))).not.toContain(agent);
    expect(offers(rowOf(rows, task))).not.toContain(spare);
    expect(offers(rowOf((await board(w.world.business, w.q)).rows, task))).toContain(spare);
  });
});

describe.skipIf(serverUrl === undefined)('Assign to AI on the board: client to client', () => {
  it('client to client: a reader held to client X’s task sees its agent and nothing of client Y’s', async () => {
    const x = await created(w, w.p, 'Client X');
    const y = await created(w, w.p, `Client Y ${CANARY}`);
    const onX = await ownedAgent(w, w.p, 'X agent');
    const onY = await ownedAgent(w, w.p, `Y agent ${CANARY}`);
    expect(codeOf(await assign(w, w.p, x, { agent: onX }))).toBe('not-a-refusal');
    expect(codeOf(await assign(w, w.p, y, { agent: onY }))).toBe('not-a-refusal');
    const reader = await enrol(w.world.db.app, w.world.business, `x-${randomUUID().slice(0, 6)}`);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, reader, 'read', { kind: 'record', id: x });
    });

    const { text, rows } = await board(w.world.business, reader);
    expect(rows.map((row) => row.id)).toStrictEqual([x]);
    expect(rowOf(rows, x)?.agent).toMatchObject({ agentId: onX });
    expect(offers(rowOf(rows, x))).toStrictEqual([]);
    expect(text).not.toContain(y);
    expect(text).not.toContain(onY);
    expect(text).not.toContain(CANARY);
  });
});

describe.skipIf(serverUrl === undefined)('Assign to AI on the board: business to business', () => {
  it('business to business: each business’s board offers its own agents and none of the other’s', async () => {
    const home = await created(w, w.p, `Home ${CANARY}`);
    const homeAgent = await ownedAgent(w, w.p, `Home agent ${CANARY}`);
    expect(codeOf(await assign(w, w.p, home, { agent: homeAgent }))).toBe('not-a-refusal');
    const bravo = await insertBusiness(w.world.db.app, `board-b-${randomUUID().slice(0, 8)}`);
    await installSpine(w.world.db.app, bravo);
    const there = await enrol(w.world.db.app, bravo, 'there');
    await w.world.db.app.withBusiness(bravo, async (tx) => {
      for (const action of ['read', 'write'] as const) {
        // eslint-disable-next-line no-await-in-loop -- two grants
        await grantTo(tx, there, action);
      }
      // Directing every agent of B reaches none of A's.
      await grantTo(tx, there, 'assign', undefined, false, 'agent');
    });
    const made = await executeCommand(w.world.db.app, bravo, there.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'Bravo task' },
    } as never);
    if (isCommandRefusal(made)) throw new Error(`bravo create refused ${made.code}`);
    const bravoTask = made.recordId ?? '';

    const theirs = await board(bravo, there);
    expect(rowOf(theirs.rows, bravoTask)?.agent).toBeNull();
    expect(offers(rowOf(theirs.rows, bravoTask))).toStrictEqual([]);
    expect(theirs.text).not.toContain(home);
    expect(theirs.text).not.toContain(homeAgent);
    expect(theirs.text).not.toContain(CANARY);
    const ours = await board(w.world.business, w.p);
    expect(ours.text).not.toContain(bravoTask);
    expect(offers(rowOf(ours.rows, home))).toContain(homeAgent);
  });
});

describe.skipIf(serverUrl === undefined)('Assign to AI on the board: an agent', () => {
  it('an agent does not read the board, and its refusal names no agent', async () => {
    const picked = await w.world.pickUp(w.p, 'the agent’s task');
    const agent = await minted(w, w.p, picked.taskId);
    const answer = await w.world.asAgent(
      { command: 'task.board', operationId: randomUUID(), board: null },
      picked.credential,
    );
    expect(codeOf(answer)).not.toBe('not-a-refusal');
    expect(JSON.stringify(answer)).not.toContain(agent);
  });
});
