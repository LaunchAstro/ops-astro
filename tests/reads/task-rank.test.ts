// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-9: the derived rank on a task's read, against a real database.
//
// The rank is derived at read and never stored (R70). Its pool is the open
// tasks the reader holds a read grant on, so a task the reader cannot see never
// shifts the number the reader is shown, and the calc line names only the task
// it is on. Each crossing below plants a canary title on the task the reader
// may not see and reads every body for it: a number that moved, or a canary in
// a body, is the leak.

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
import { agentWorld, detailOf, codeOf, type AgentWorld } from '../commands/agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task-rank: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

type Body = Readonly<Record<string, unknown>>;
type Marks = readonly [number | null, number | null, number | null];

const CANARY = `canary-${randomUUID()}`;

describe.skipIf(serverUrl === undefined)('MP-4-9 rank on the task read', () => {
  let db: FreshDatabase;
  let alpha: BusinessId;
  let bravo: BusinessId;
  let owner: Member;
  let bravoOwner: Member;
  let clientAViewer: Member;
  let pairViewer: Member;
  let nobody: Member;
  const ids: Record<string, string> = {};

  const command = async (business: BusinessId, member: Member, body: Body) => {
    const answer = await executeCommand(db.app, business, member.presented, 'api', {
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
        await db.admin.execute<{ readonly revision: string }>(
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
    marks: Marks,
    client?: string,
  ) => {
    const made = await command(business, by, { command: 'task.create', fields: { title } });
    const recordId = made.recordId ?? '';
    const [impact, confidence, ease] = marks;
    await command(business, by, {
      command: 'task.set_scores',
      recordId,
      expectedRevision: await revisionOf(recordId),
      fields: { impact, confidence, ease },
    });
    if (client !== undefined) {
      await command(business, by, {
        command: 'task.set_party',
        recordId,
        expectedRevision: await revisionOf(recordId),
        fields: { client },
      });
    }
    ids[name] = recordId;
    return recordId;
  };

  const read = async (business: BusinessId, member: Member, recordId: string) =>
    await executeRead(db.app, business, member.presented, { read: 'task.read', recordId });

  const rankOf = async (business: BusinessId, member: Member, recordId: string) => {
    const answer = await read(business, member, recordId);
    if (isCommandRefusal(answer) || !('task' in answer)) {
      throw new Error(`task.read did not answer a task: ${JSON.stringify(answer)}`);
    }
    return answer.task.rank;
  };

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'r' });
    alpha = (await insertBusiness(db.app, 'rank-alpha')) as BusinessId;
    bravo = (await insertBusiness(db.app, 'rank-bravo')) as BusinessId;
    await installSpine(db.app, alpha);
    await installSpine(db.app, bravo);
    owner = await enrol(db.app, alpha, 'owner');
    bravoOwner = await enrol(db.app, bravo, 'bravo-owner');
    clientAViewer = await enrol(db.app, alpha, 'client-a-viewer');
    pairViewer = await enrol(db.app, alpha, 'pair-viewer');
    nobody = await enrol(db.app, alpha, 'nobody');
    await db.app.withBusiness(alpha, async (tx) => {
      // `share` only so each task can be put under its client (`task.set_party`).
      for (const action of ['read', 'write', 'share'] as const) {
        // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
        await grantTo(tx, owner, action);
      }
    });
    await db.app.withBusiness(bravo, async (tx) => {
      for (const action of ['read', 'write'] as const) {
        // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
        await grantTo(tx, bravoOwner, action);
      }
    });
    const clientA = randomUUID();
    const clientB = randomUUID();
    // Alpha: 504, 900 (client B, the canary), 630, and one unscored.
    await make(alpha, owner, 'a504', 'client A work', [7, 9, 8], clientA);
    await make(alpha, owner, 'b900', CANARY, [10, 10, 9], clientB);
    await make(alpha, owner, 'a630', 'second', [7, 9, 10], clientA);
    await make(alpha, owner, 'unscored', 'no ease yet', [5, 7, null]);
    // Bravo: a task that outscores everything in Alpha.
    await make(bravo, bravoOwner, 'bravo', CANARY, [10, 10, 10]);
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, clientAViewer, 'read', { kind: 'record', id: ids['a504'] ?? '' });
      await grantTo(tx, pairViewer, 'read', { kind: 'record', id: ids['a504'] ?? '' });
      await grantTo(tx, pairViewer, 'read', { kind: 'record', id: ids['a630'] ?? '' });
    });
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('MP-4-9 rank or not ranked', () => {
    it('a whole-business reader sees #N over every open task it may read', async () => {
      const ranks = await Promise.all(
        ['b900', 'a630', 'a504'].map(async (name) => await rankOf(alpha, owner, ids[name] ?? '')),
      );
      expect(ranks.map((rank) => [rank.number, rank.score])).toStrictEqual([
        [1, 900],
        [2, 630],
        [3, 504],
      ]);
    });

    it('a task missing a mark is "not ranked", with no number and no score', async () => {
      const rank = await rankOf(alpha, owner, ids['unscored'] ?? '');
      expect([rank.number, rank.score, rank.calc]).toStrictEqual([
        null,
        null,
        'not ranked: missing ease',
      ]);
    });

    it('carries the calc line of its own marks', async () => {
      const rank = await rankOf(alpha, owner, ids['a504'] ?? '');
      expect(rank.calc).toBe(
        'impact 7 × confidence 9 × ease 8 × priority 1 × age 1 = 504 · derived',
      );
    });

    it('is never stored: a mark changed is the next read’s number', async () => {
      const recordId = await make(alpha, owner, 'late', 'late riser', [1, 1, 1]);
      expect((await rankOf(alpha, owner, recordId)).number).toBe(4);
      await command(alpha, owner, {
        command: 'task.set_scores',
        recordId,
        expectedRevision: await revisionOf(recordId),
        fields: { impact: 10, confidence: 10, ease: 10 },
      });
      expect((await rankOf(alpha, owner, recordId)).number).toBe(1);
      await command(alpha, owner, {
        command: 'task.set_scores',
        recordId,
        expectedRevision: await revisionOf(recordId),
        fields: { impact: null },
      });
    });
  });

  describe('MP-4-9 isolation', () => {
    it('another business: its higher score never moves an Alpha number, and its task is not found', async () => {
      expect((await rankOf(alpha, owner, ids['b900'] ?? '')).number).toBe(1);
      const foreign = await read(alpha, owner, ids['bravo'] ?? '');
      expect(isCommandRefusal(foreign) ? foreign.code : 'answered').toBe('NOT_FOUND');
      expect(JSON.stringify(foreign)).not.toContain(CANARY);
    });

    it('another client in the same business: a client A reader is #1 of what it may read', async () => {
      const answer = await read(alpha, clientAViewer, ids['a504'] ?? '');
      expect(isCommandRefusal(answer)).toBe(false);
      const rank = (answer as { task: { rank: { number: number | null } } }).task.rank;
      expect(rank.number).toBe(1);
      expect(JSON.stringify(answer)).not.toContain(CANARY);
      expect(JSON.stringify(answer)).not.toContain(ids['b900']);
      const refused = await read(alpha, clientAViewer, ids['b900'] ?? '');
      expect(isCommandRefusal(refused) ? refused.code : 'answered').toBe('SCOPE_NOT_GRANTED');
      expect(JSON.stringify(refused)).not.toContain(CANARY);
    });

    it('a member with no grant is refused and shown no number', async () => {
      const refused = await read(alpha, nobody, ids['a504'] ?? '');
      expect(isCommandRefusal(refused) ? refused.code : 'answered').toBe('SCOPE_NOT_GRANTED');
      expect(JSON.stringify(refused)).not.toMatch(/"rank"|#\d/u);
    });
  });

  describe('MP-4-9 inherited scope', () => {
    it('a task the reader cannot see never shifts the reader’s #N', async () => {
      // The whole business reads a630 as #2 behind the canary; a reader of
      // a630 and a504 only reads it as #1.
      expect((await rankOf(alpha, owner, ids['a630'] ?? '')).number).toBe(2);
      expect((await rankOf(alpha, pairViewer, ids['a630'] ?? '')).number).toBe(1);
      expect((await rankOf(alpha, pairViewer, ids['a504'] ?? '')).number).toBe(2);
    });

    it('the calc line names no task or client the reader holds no grant on', async () => {
      const ranks = await Promise.all(
        ['a504', 'a630'].map(async (name) => await rankOf(alpha, pairViewer, ids[name] ?? '')),
      );
      for (const rank of ranks) {
        expect(rank.calc).not.toContain(CANARY);
        expect(rank.calc).not.toContain(ids['b900'] ?? 'never');
      }
    });
  });
});

describe.skipIf(serverUrl === undefined)(
  'MP-4-9 isolation: an agent under a live delegation',
  () => {
    let world: AgentWorld;

    beforeAll(async () => {
      world = await agentWorld('rk', `rank-agent-${randomUUID().slice(0, 8)}`);
    }, 180_000);

    afterAll(async () => {
      await world?.drop();
    });

    it('ranks its one delegated task #1 and names no other task', async () => {
      const decider = await world.decider('decider');
      const revision = async (recordId: string) =>
        Number(
          (
            await world.db.admin.execute<{ readonly revision: string }>(
              `select revision::text as revision from public.records where id = $1`,
              [recordId],
            )
          )[0]?.revision,
        );
      const other = await world.asPerson(decider, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: CANARY },
      });
      const otherId = isCommandRefusal(other) ? '' : (other.recordId ?? '');
      await world.asPerson(decider, {
        command: 'task.set_scores',
        operationId: randomUUID(),
        recordId: otherId,
        expectedRevision: await revision(otherId),
        fields: { impact: 10, confidence: 10, ease: 10 },
      });
      const picked = await world.pickUp(decider, 'the agent’s task');
      await world.asPerson(decider, {
        command: 'task.set_scores',
        operationId: randomUUID(),
        recordId: picked.taskId,
        expectedRevision: await revision(picked.taskId),
        fields: { impact: 2, confidence: 2, ease: 2 },
      });
      const own = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
        picked.credential,
      );
      const task = detailOf(own)['task'] as { rank: { number: number | null; calc: string } };
      expect([task.rank.number, task.rank.calc]).toStrictEqual([
        1,
        'impact 2 × confidence 2 × ease 2 × priority 1 × age 1 = 8 · derived',
      ]);
      expect(JSON.stringify(own)).not.toContain(CANARY);
      const foreign = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: otherId },
        picked.credential,
      );
      expect(codeOf(foreign)).not.toBe('not-a-refusal');
      expect(JSON.stringify(foreign)).not.toContain(CANARY);
    });
  },
);

describe('MP-4-9 harness captures', () => {
  // SL08 LEANS-ON SL02 (U02, MP-1-7): the width-and-theme harness is on
  // slice/SL02 and not on main; the rank's captures at 1480, 900 and 390,
  // light and dark, are taken with it once it lands.
  it.todo('the task page rank and calc line at 1480, 900 and 390, light and dark');
});
