// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-11: the reason a task waits, read by task.board against a real
// database, so the Projects board prints it after its group's heading.
//
// Main's run lifecycle has one wait the board can read: a run awaiting
// approval, stored as a gate that is pending, not expired, on a version not
// superseded (`needs_approval`). The reason is the task's own fact, so every
// reader of the row sees it, whether or not they may decide the gate; a gate
// decided or expired leaves no reason (`MP-5-11 waiting reasons`). It is read
// only over the rows served, so no reason, gate or canary of a task the
// caller cannot read reaches them (`MP-5-11 isolation`).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { agentWorld, codeOf, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'mp-5-11-board-wait-reason: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Body = Readonly<Record<string, unknown>>;

interface BoardRow {
  readonly id: string;
  readonly waitReason: string | null;
  readonly awaitingDecision: boolean;
}

const CANARY = `canary-${randomUUID()}`;

let world: AgentWorld;
let decider: Decider;
let reader: Member;
let pair: Member;
let bravo: BusinessId;
let bravoOwner: Member;
const ids: Record<string, string> = {};
const gates: Record<string, { readonly gateId: string; readonly versionId: string }> = {};

const id = (name: string): string => ids[name] ?? `missing-${name}`;

const done = (result: Awaited<ReturnType<AgentWorld['asPerson']>>, what: string): Body => {
  if (isCommandRefusal(result)) throw new Error(`${what} refused ${result.code}`);
  return { ...(result.detail as Record<string, unknown>), recordId: result.recordId };
};

const create = async (name: string, title: string) => {
  const made = await world.asPerson(decider, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
  });
  ids[name] = String(done(made, 'task.create')['recordId']);
};

/** Opens a gate on the task: its run waits for approval. */
const propose = async (name: string) => {
  const stored = await world.db.admin.execute<{ readonly revision: string }>(
    `select revision::text as revision from public.records where id = $1`,
    [id(name)],
  );
  const proposed = done(
    await world.asPerson(decider, {
      command: 'task.propose',
      operationId: randomUUID(),
      recordId: id(name),
      expectedRevision: Number(stored[0]?.revision),
      purpose: `draft_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    } as Body),
    'task.propose',
  );
  gates[name] = { gateId: String(proposed['gateId']), versionId: String(proposed['versionId']) };
};

const decide = async (name: string) => {
  done(
    await world.asPerson(decider, {
      command: 'task.decide',
      operationId: randomUUID(),
      gateId: gates[name]?.gateId,
      versionId: gates[name]?.versionId,
      decision: 'reject',
      note: 'not this one',
    }),
    'task.decide',
  );
};

const board = async (business: BusinessId, member: Member) =>
  await executeRead(world.db.app, business, member.presented, { read: 'task.board', board: null });

const rowsOf = async (member: Member): Promise<ReadonlyMap<string, BoardRow>> => {
  const answer = await board(world.business, member);
  if (isCommandRefusal(answer) || !('tasks' in answer)) {
    throw new Error(`task.board did not answer: ${JSON.stringify(answer)}`);
  }
  const rows = answer.tasks as unknown as readonly BoardRow[];
  return new Map(rows.map((row) => [row.id, row]));
};

const reasons = async (member: Member, names: readonly string[]) => {
  const rows = await rowsOf(member);
  return names.map((name) => rows.get(id(name))?.waitReason);
};

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await agentWorld('b8', `mp511-wait-${randomUUID().slice(0, 8)}`);
  decider = await world.decider('decider');
  reader = await enrol(world.db.app, world.business, 'reader');
  pair = await enrol(world.db.app, world.business, 'pair');
  await create('waiting', 'waits for approval');
  await create('quiet', 'no gate');
  await create('decided', 'decided already');
  await create('lapsed', 'gate expired');
  await create('other', CANARY);
  for (const name of ['waiting', 'decided', 'lapsed', 'other']) {
    // eslint-disable-next-line no-await-in-loop -- each proposal reads the revision the last one left
    await propose(name);
  }
  await decide('decided');
  await world.db.admin.execute(
    `update public.gates set expires_at = now() - interval '1 minute' where id = $1`,
    [gates['lapsed']?.gateId],
  );
  await world.db.app.withBusiness(world.business, async (tx) => {
    // Reads the whole board and decides nothing.
    await grantTo(tx, reader, 'read');
    // Reads one client's two tasks: the one waiting and the quiet one.
    await grantTo(tx, pair, 'read', { kind: 'record', id: id('waiting') });
    await grantTo(tx, pair, 'read', { kind: 'record', id: id('quiet') });
  });
  bravo = (await insertBusiness(
    world.db.app,
    `mp511-wait-bravo-${randomUUID().slice(0, 8)}`,
  )) as BusinessId;
  await installSpine(world.db.app, bravo);
  bravoOwner = await enrol(world.db.app, bravo, 'bravo-owner');
  await world.db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoOwner, 'read');
  });
}, 240_000);

afterAll(async () => {
  await world?.drop();
});

describe.skipIf(serverUrl === undefined)('MP-5-11 waiting reasons', () => {
  it('reads the reason of a run awaiting approval, and none for a decided, expired or absent gate', async () => {
    expect(
      await reasons(decider, ['waiting', 'other', 'quiet', 'decided', 'lapsed']),
    ).toStrictEqual(['needs_approval', 'needs_approval', null, null, null]);
  });

  it('is the task’s fact, not the caller’s: a reader who cannot decide sees the same reasons', async () => {
    const rows = await rowsOf(reader);
    expect(rows.get(id('waiting'))?.waitReason).toBe('needs_approval');
    expect(rows.get(id('waiting'))?.awaitingDecision).toBe(false);
  });

  it('is live: a gate decided leaves no reason on the next read', async () => {
    await propose('quiet');
    expect(await reasons(reader, ['quiet'])).toStrictEqual(['needs_approval']);
    await decide('quiet');
    expect(await reasons(reader, ['quiet'])).toStrictEqual([null]);
  });
});

describe.skipIf(serverUrl === undefined)('MP-5-11 isolation', () => {
  it('another client in the same business: a reader of one client’s tasks gets only their reasons', async () => {
    const answer = await board(world.business, pair);
    const rows = await rowsOf(pair);
    expect([...rows.keys()].toSorted()).toStrictEqual([id('waiting'), id('quiet')].toSorted());
    expect(rows.get(id('waiting'))?.waitReason).toBe('needs_approval');
    const text = JSON.stringify(answer);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(id('other'));
    expect(text).not.toContain(gates['waiting']?.gateId ?? 'none');
    expect(text).not.toContain(gates['other']?.gateId ?? 'none');
  });

  it('another business: its reader is refused this board, shown no reason or canary', async () => {
    const crossing = await board(world.business, bravoOwner);
    expect(isCommandRefusal(crossing) ? crossing.code : 'answered').not.toBe('answered');
    const text = JSON.stringify(crossing);
    expect(text).not.toContain(CANARY);
    expect(text).not.toMatch(/"waitReason"|needs_approval/u);
    const own = JSON.stringify(await board(bravo, bravoOwner));
    expect(own).not.toContain(id('waiting'));
    expect(own).not.toContain('needs_approval');
  });

  it('another person under a live delegation: the agent is refused, shown no reason or canary', async () => {
    const picked = await world.pickUp(decider, 'the agent’s task');
    const answer = await world.asAgent(
      { command: 'task.board', operationId: randomUUID(), board: null },
      picked.credential,
    );
    expect(codeOf(answer)).toBe('DELEGATION_EXCLUDES_OPERATION');
    const text = JSON.stringify(answer);
    expect(text).not.toContain(CANARY);
    expect(text).not.toMatch(/"waitReason"|needs_approval/u);
  });
});
