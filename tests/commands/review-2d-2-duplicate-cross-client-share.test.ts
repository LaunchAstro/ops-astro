// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2D-2 (REVIEW-BATCH #315, batch 2d): a duplicate that lands under a
// different client than its source moves the work across clients, which
// `task.set_party` guards with task:share. Owner ruling: the cross-client
// duplicate needs task:share at the target; a duplicate within the source's
// own client keeps task:write. Red proof: case a fails while the handler asks
// only `write` at the target (tasks-duplicate.ts refuseAuthority).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from './fixture.ts';
import {
  alpha,
  clientA,
  clientB,
  db,
  duplicate,
  footprint,
  outcomeOf,
  owner,
  person,
  serverUrl,
  setUp,
  taskFor,
  tearDown,
} from './duplicate-world.ts';

if (serverUrl === undefined) {
  console.warn('review-2d-2: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

describe.skipIf(serverUrl === undefined)(
  'REVIEW-2D-2: cross-client duplicate needs task:share',
  () => {
    it('REVIEW-2D-2: business-wide task:write without task:share cannot duplicate into another client', async () => {
      const old = await taskFor(alpha, owner, 'source under client A', clientA);
      const writer = await person('writer-no-share');
      await db.app.withBusiness(alpha, async (tx) => {
        await grantTo(tx, writer, 'read');
        await grantTo(tx, writer, 'write');
      });
      const before = await footprint();
      const answer = await duplicate(writer, { recordId: old, client: clientB, title: 'moved' });
      expect(outcomeOf(answer)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect(await footprint()).toStrictEqual(before);
    });

    it('REVIEW-2D-2: control, task:write duplicates within the source client', async () => {
      const old = await taskFor(alpha, owner, 'source under client A, same', clientA);
      const writer = await person('writer-same-client');
      await db.app.withBusiness(alpha, async (tx) => {
        await grantTo(tx, writer, 'read');
        await grantTo(tx, writer, 'write');
      });
      const answer = await duplicate(writer, { recordId: old, client: clientA, title: 'kept' });
      expect(outcomeOf(answer)).toStrictEqual({ applied: true });
    });
  },
);
