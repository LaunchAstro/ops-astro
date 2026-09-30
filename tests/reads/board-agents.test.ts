// SPDX-License-Identifier: AGPL-3.0-only
//
// Assign to AI on the board (agent assignee ruling point 9): each row of
// `task.board` carries what `task.read` carries for the same task and reader,
// `agent` (the delegation holding it, only when it is the reader's own) and
// `myAgents` (the reader's own live delegations that reach it). Nobody else's
// agent is listed, counted or hinted. Three real crossings, statuses checked:
// another person, another client in the same business, another business; and
// an agent, which never reads the board.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { mintDelegation, type BusinessId } from '../../packages/core-records/src/index.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import {
  CANARY,
  aiWorld,
  assign,
  created,
  minted,
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
  readonly agent?: { readonly delegationId: string } | null;
  readonly myAgents?: readonly { readonly delegationId: string }[];
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

const offers = (row: Row | undefined): readonly string[] | undefined =>
  row?.myAgents?.map((one) => one.delegationId);

/** A live delegation held by `member`, for the world's agent, on one task. */
const mintedFor = async (member: Member, taskId: string): Promise<string> =>
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const made = await mintDelegation(tx, {
      agentActorId: w.world.agentActorId,
      delegatePersonId: member.personId,
      mintedByActorId: member.actorId,
      purpose: `ai_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!made.ok) throw new Error(`fixture: the mint was refused ${made.refusal.code}`);
    return made.value.delegation.id;
  });

describe.skipIf(serverUrl === undefined)('Assign to AI on the board', () => {
  it('a row shows the reader’s own agent holding it, and each row offers the reader’s own agents for it', async () => {
    const held = await created(w, w.p, 'held by my agent');
    const open = await created(w, w.p, 'my agent may take it');
    const holding = await minted(w, w.p, held);
    const offered = await minted(w, w.p, open);
    expect(codeOf(await assign(w, w.p, held, { agent: holding }))).toBe('not-a-refusal');

    const { rows } = await board(w.world.business, w.p);
    expect(rowOf(rows, held)?.agent?.delegationId).toBe(holding);
    expect(offers(rowOf(rows, held))).toStrictEqual([holding]);
    expect(rowOf(rows, open)?.agent).toBeNull();
    expect(offers(rowOf(rows, open))).toStrictEqual([offered]);
  });
});

describe.skipIf(serverUrl === undefined)('Assign to AI on the board: crossings', () => {
  it('person to person: Q’s agent on a row gives P no agent, no offer and no id', async () => {
    const task = await created(w, w.q, `Q's ${CANARY}`);
    const agent = await minted(w, w.q, task);
    const spare = await minted(w, w.q, task);
    expect(codeOf(await assign(w, w.q, task, { agent }))).toBe('not-a-refusal');

    const { text, rows } = await board(w.world.business, w.p);
    expect(rowOf(rows, task)?.agent).toBeNull();
    expect(offers(rowOf(rows, task))).toStrictEqual([]);
    expect(text).not.toContain(agent);
    expect(text).not.toContain(spare);
    // Q, reading the same board, is shown their own.
    expect(rowOf((await board(w.world.business, w.q)).rows, task)?.agent?.delegationId).toBe(agent);
  });

  it('client to client: a reader held to client X’s task is offered its agent there and nothing of client Y’s', async () => {
    const x = await created(w, w.p, 'Client X');
    const y = await created(w, w.p, `Client Y ${CANARY}`);
    const reader = await enrol(w.world.db.app, w.world.business, `x-${randomUUID().slice(0, 6)}`);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, reader, 'read', { kind: 'record', id: x });
      await grantTo(tx, reader, 'read');
    });
    const onX = await mintedFor(reader, x);
    const onY = await mintedFor(reader, y);
    // The business-wide grant a mint asks for ends, leaving the reader held
    // to X; the delegation on Y is still live and still the reader's own,
    // which is what the board must not show.
    await w.world.db.admin.execute(
      `update public.grants set revoked_at = now()
        where subject_id = $1 and scope_kind = 'business'`,
      [reader.personId],
    );

    const { text, rows } = await board(w.world.business, reader);
    expect(rows.map((row) => row.id)).toStrictEqual([x]);
    expect(offers(rowOf(rows, x))).toStrictEqual([onX]);
    expect(text).not.toContain(y);
    expect(text).not.toContain(onY);
    expect(text).not.toContain(CANARY);
  });

  it('business to business: each business’s board offers its own agents and none of the other’s', async () => {
    const home = await created(w, w.p, `Home ${CANARY}`);
    const homeAgent = await minted(w, w.p, home);
    const bravo = await insertBusiness(w.world.db.app, `board-b-${randomUUID().slice(0, 8)}`);
    await installSpine(w.world.db.app, bravo);
    const there = await enrol(w.world.db.app, bravo, 'there');
    await w.world.db.app.withBusiness(bravo, async (tx) => {
      for (const action of ['read', 'write'] as const) {
        // eslint-disable-next-line no-await-in-loop -- two grants
        await grantTo(tx, there, action);
      }
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
    expect(offers(rowOf(ours.rows, home))).toStrictEqual([homeAgent]);
  });

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
