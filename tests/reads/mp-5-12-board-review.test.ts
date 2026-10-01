// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-12: the Projects board's Review mode reads which tasks wait at a gate
// for the viewer's decision, against a real database.
//
// Each task.board row carries `awaitingDecision`: its task has a pending gate
// that has not expired, and the caller's own decide grant reaches the task,
// the one `task.decide` checks. A reader without decide sees no task waiting
// on them; a decided or expired gate waits on nobody; a record-scoped decide
// grant flags only its own task (`MP-5-12 review count`). The flag is read over
// the rows the board already serves, so it never names or counts a task the
// caller cannot read (`MP-5-12 isolation`). The answer names its own caller
// as `viewer`, the person the viewer preset narrows to, and never anyone else
// (`MP-5-12 viewer preset`).

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
    'mp-5-12-board-review: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Body = Readonly<Record<string, unknown>>;

interface BoardRow {
  readonly id: string;
  readonly awaitingDecision: boolean;
}

const CANARY = `canary-${randomUUID()}`;

let world: AgentWorld;
let decider: Decider;
let reader: Member;
let pairDecider: Member;
let bravo: BusinessId;
let bravoOwner: Member;
const ids: Record<string, string> = {};
const gates: Record<string, string> = {};

const revisionOf = async (recordId: string) =>
  Number(
    (
      await world.db.admin.execute<{ readonly revision: string }>(
        `select revision::text as revision from public.records where id = $1`,
        [recordId],
      )
    )[0]?.revision,
  );

const done = (
  result: Awaited<ReturnType<AgentWorld['asPerson']>>,
  what: string,
): Readonly<Record<string, unknown>> => {
  if (isCommandRefusal(result)) throw new Error(`${what} refused ${result.code}`);
  return { ...(result.detail as Record<string, unknown>), recordId: result.recordId };
};

const create = async (name: string, title: string) => {
  const made = done(
    await world.asPerson(decider, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title },
    }),
    'task.create',
  );
  ids[name] = String(made['recordId']);
};

/** Opens a gate on the task: a proposal waiting for a decision. */
const propose = async (name: string) => {
  const taskId = ids[name] ?? '';
  const proposed = done(
    await world.asPerson(decider, {
      command: 'task.propose',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
      purpose: `draft_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    } as Body),
    'task.propose',
  );
  gates[name] = String(proposed['gateId']);
  return proposed;
};

const board = async (business: BusinessId, member: Member) =>
  await executeRead(world.db.app, business, member.presented, { read: 'task.board', board: null });

const viewerOf = async (business: BusinessId, member: Member): Promise<unknown> => {
  const answer = await board(business, member);
  return isCommandRefusal(answer) ? answer.code : (answer as Body)['viewer'];
};

const flags = async (member: Member): Promise<Readonly<Record<string, boolean>>> => {
  const answer = await board(world.business, member);
  if (isCommandRefusal(answer) || !('tasks' in answer)) {
    throw new Error(`task.board did not answer: ${JSON.stringify(answer)}`);
  }
  const rows = answer.tasks as unknown as readonly BoardRow[];
  return Object.fromEntries(rows.map((row) => [row.id, row.awaitingDecision]));
};

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await agentWorld('b8', `mp512-${randomUUID().slice(0, 8)}`);
  decider = await world.decider('decider');
  reader = await enrol(world.db.app, world.business, 'reader');
  pairDecider = await enrol(world.db.app, world.business, 'pair-decider');
  await create('waiting', 'waits for a decision');
  await create('quiet', 'no gate');
  await create('decided', 'decided already');
  await create('lapsed', 'gate expired');
  await create('other', CANARY);
  await propose('waiting');
  await propose('lapsed');
  await propose('other');
  const decidedGate = await propose('decided');
  done(
    await world.asPerson(decider, {
      command: 'task.decide',
      operationId: randomUUID(),
      gateId: decidedGate['gateId'],
      versionId: decidedGate['versionId'],
      decision: 'reject',
      note: 'not this one',
    }),
    'task.decide',
  );
  await world.db.admin.execute(
    `update public.gates set expires_at = now() - interval '1 minute' where id = $1`,
    [gates['lapsed']],
  );
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, reader, 'read');
    // Reads two tasks, and may decide only one of them.
    await grantTo(tx, pairDecider, 'read', { kind: 'record', id: ids['waiting'] ?? '' });
    await grantTo(tx, pairDecider, 'read', { kind: 'record', id: ids['quiet'] ?? '' });
    await grantTo(tx, pairDecider, 'decide', { kind: 'record', id: ids['quiet'] ?? '' });
  });
  bravo = (await insertBusiness(
    world.db.app,
    `mp512-bravo-${randomUUID().slice(0, 8)}`,
  )) as BusinessId;
  await installSpine(world.db.app, bravo);
  bravoOwner = await enrol(world.db.app, bravo, 'bravo-owner');
  await world.db.app.withBusiness(bravo, async (tx) => {
    for (const action of ['read', 'decide'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, bravoOwner, action);
    }
  });
}, 240_000);

afterAll(async () => {
  await world?.drop();
});

describe.skipIf(serverUrl === undefined)('MP-5-12 review count', () => {
  it('flags the tasks waiting at an open gate for the viewer’s decision, and no other', async () => {
    const seen = await flags(decider);
    expect([
      seen[ids['waiting'] ?? ''],
      seen[ids['other'] ?? ''],
      seen[ids['quiet'] ?? ''],
      seen[ids['decided'] ?? ''],
      seen[ids['lapsed'] ?? ''],
    ]).toStrictEqual([true, true, false, false, false]);
  });

  it('waits on nobody who cannot decide: a reader without decide sees none waiting on them', async () => {
    const seen = await flags(reader);
    expect(Object.values(seen)).toStrictEqual([false, false, false, false, false]);
  });

  it('is live: a gate decided is off the next read', async () => {
    const before = await flags(decider);
    expect(before[ids['waiting'] ?? '']).toBe(true);
    const lapsed = await world.db.admin.execute<{ readonly version_id: string }>(
      `select version_id from public.gates where id = $1`,
      [gates['other']],
    );
    done(
      await world.asPerson(decider, {
        command: 'task.decide',
        operationId: randomUUID(),
        gateId: gates['other'],
        versionId: lapsed[0]?.version_id,
        decision: 'reject',
        note: 'decided in the test',
      }),
      'task.decide',
    );
    expect((await flags(decider))[ids['other'] ?? '']).toBe(false);
  });
});

describe.skipIf(serverUrl === undefined)('MP-5-12 viewer preset', () => {
  it('names the signed-in person as the viewer, whoever else is on the board', async () => {
    expect(await viewerOf(world.business, decider)).toBe(decider.personId);
    expect(await viewerOf(world.business, reader)).toBe(reader.personId);
  });

  it('isolation: a record-scoped reader and another business are each told only themselves', async () => {
    expect(await viewerOf(world.business, pairDecider)).toBe(pairDecider.personId);
    expect(await viewerOf(bravo, bravoOwner)).toBe(bravoOwner.personId);
    const crossing = JSON.stringify(await board(world.business, bravoOwner));
    expect(crossing).not.toContain(decider.personId);
    expect(crossing).not.toMatch(/"viewer"/u);
  });
});

describe.skipIf(serverUrl === undefined)('MP-5-12 isolation', () => {
  it('another client in the same business: a decide grant on one task flags only that task', async () => {
    const answer = await board(world.business, pairDecider);
    const seen = await flags(pairDecider);
    // It reads the waiting task but may not decide it; it may decide the quiet one, which waits on nobody.
    expect(seen).toStrictEqual({ [ids['waiting'] ?? '']: false, [ids['quiet'] ?? '']: false });
    const text = JSON.stringify(answer);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(ids['other'] ?? 'none');
    expect(text).not.toContain(gates['waiting'] ?? 'none');
  });

  it('another business: a decider there is refused this board, shown no flag or canary', async () => {
    const crossing = await board(world.business, bravoOwner);
    expect(isCommandRefusal(crossing) ? crossing.code : 'answered').not.toBe('answered');
    const text = JSON.stringify(crossing);
    expect(text).not.toContain(CANARY);
    expect(text).not.toMatch(/"awaitingDecision"/u);
    const own = await board(bravo, bravoOwner);
    expect(JSON.stringify(own)).not.toContain(ids['waiting'] ?? 'none');
  });

  it('another person under a live delegation: the agent is refused, shown no flag or canary', async () => {
    const picked = await world.pickUp(decider, 'the agent’s task');
    const answer = await world.asAgent(
      { command: 'task.board', operationId: randomUUID(), board: null },
      picked.credential,
    );
    expect(codeOf(answer)).toBe('DELEGATION_EXCLUDES_OPERATION');
    const text = JSON.stringify(answer);
    expect(text).not.toContain(CANARY);
    expect(text).not.toMatch(/"awaitingDecision"/u);
  });
});
