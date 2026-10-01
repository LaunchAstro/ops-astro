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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  CANARY,
  alpha,
  clientAViewer,
  command,
  ids,
  make,
  nobody,
  owner,
  pairViewer,
  rankOf,
  read,
  revisionOf,
  serverUrl,
  setUp,
  tearDown,
} from './rank-world.ts';

if (serverUrl === undefined) {
  console.warn('task-rank: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

describe.skipIf(serverUrl === undefined)('MP-4-9 rank on the task read', () => {
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
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-9 rank on the task read', () => {
  describe('MP-4-9 rank or not ranked', () => {
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
});

describe.skipIf(serverUrl === undefined)('MP-4-9 rank on the task read', () => {
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
});

describe.skipIf(serverUrl === undefined)('MP-4-9 rank on the task read', () => {
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
