// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-10 client access: cases kept beside task-client-access.test.ts, each
// file under the line limit.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo, type Member } from './fixture.ts';
import {
  CANARY,
  SHARE,
  admin,
  alpha,
  as,
  bravo,
  bravoAdmin,
  clientA,
  clientAPeople,
  clientB,
  clientBPerson,
  db,
  fresh,
  liveHolders,
  outcomeOf,
  readAs,
  revisionOf,
  scopedSharer,
  serverUrl,
  setUp,
  sharesOf,
  tearDown,
  toggle,
} from './client-access-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-client-access: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

describe.skipIf(serverUrl === undefined)('MP-4-10 client access', () => {
  describe('MP-4-10 isolation: client access', () => {
    it('another business: its task is not found and gains no share', async () => {
      const foreign = await fresh(bravo, bravoAdmin, CANARY, clientA);
      const answer = await as(alpha, admin, {
        command: SHARE,
        recordId: foreign,
        expectedRevision: await revisionOf(foreign),
      });
      expect(outcomeOf(answer)).toMatchObject({ code: 'NOT_FOUND' });
      expect(JSON.stringify(answer)).not.toContain(CANARY);
      expect(await sharesOf(foreign)).toHaveLength(0);
      // And bravo turning on its own task shares with none of alpha's client people.
      await toggle(bravo, bravoAdmin, SHARE, foreign);
      expect(await sharesOf(foreign)).toHaveLength(0);
    });

    it('another client in the same business: client A’s task reaches client A’s people only', async () => {
      const taskA = await fresh(alpha, admin, 'client A only', clientA);
      const taskB = await fresh(alpha, admin, CANARY, clientB);
      await toggle(alpha, admin, SHARE, taskA);
      expect(await liveHolders(taskA)).not.toContain(clientBPerson.personId);
      const crossRead = await readAs(alpha, clientBPerson, taskA);
      expect(outcomeOf(crossRead)).toMatchObject({ code: 'NOT_FOUND' });
      // Client A's person cannot open client B's task, shared or not.
      await toggle(alpha, admin, SHARE, taskB);
      const other = await readAs(alpha, clientAPeople[0] as Member, taskB);
      expect(outcomeOf(other)).toMatchObject({ code: 'NOT_FOUND' });
      expect(JSON.stringify(other)).not.toContain(CANARY);
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-10 client access', () => {
  describe('MP-4-10 isolation: client access', () => {
    it('a sharer scoped to client A’s task cannot share client B’s', async () => {
      const taskA = await fresh(alpha, admin, 'scoped A', clientA);
      const taskB = await fresh(alpha, admin, CANARY, clientB);
      await db.app.withBusiness(alpha, async (tx) => {
        await grantTo(tx, scopedSharer, 'share', { kind: 'record', id: taskA }, false, 'access');
      });
      expect(outcomeOf(await toggle(alpha, scopedSharer, SHARE, taskA))).toStrictEqual({
        applied: true,
      });
      const refused = await toggle(alpha, scopedSharer, SHARE, taskB);
      expect(outcomeOf(refused)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect(JSON.stringify(refused)).not.toContain(CANARY);
      expect(await sharesOf(taskB)).toHaveLength(0);
    });
  });
});
