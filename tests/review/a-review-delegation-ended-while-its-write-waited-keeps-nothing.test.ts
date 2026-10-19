// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2103): an agent's open or capture under a `review:write` delegation asks the delegation
// and its person's `review:write` at the review's holder again after its last lock wait. Each
// case is a real race on three connections: the agent's call on the app's own, a holder of the
// review row on a second, and the revocation committed on a third while the call is seen parked
// on that row. Each call is refused once it gets through, and nothing it would have written is
// kept.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  revokeDelegation,
  revokeGrant,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { awaitParked, holdRows, racer, type Schedules } from '../runtime/schedules-harness.ts';
import { ABOUT, PAGE, c35World, type C35World } from './c35-world.ts';
import { delegateReview, type ReviewDelegation } from './c35-delegated.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 delegated race: DATABASE_URL is unset.');

let w: C35World;
let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c35delegatedwait');
  s = { db: w.world.db, business: w.world.business } as Schedules;
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** A fresh person holding `review:write` business-wide, and a delegation for task A on it. */
async function delegatingPerson(name: string) {
  const member = await enrol(w.world.db.app, w.world.business, name);
  const grantId = await w.world.db.app.withBusiness(
    w.world.business,
    async (tx) =>
      await grantTo(tx, member, 'write', { kind: 'business', id: null }, false, 'review'),
  );
  return { grantId, delegation: await delegateReview(w, member, w.taskA) };
}

/** `revoke` committed on a connection of its own, giving up after two seconds. */
async function revokeElsewhere(revoke: (tx: TenantQuery) => Promise<unknown>): Promise<boolean> {
  const revoker = racer(s);
  try {
    return await revoker.withBusiness(w.world.business, async (tx) => {
      await tx.query("set local lock_timeout = '2s'");
      return (await revoke(tx)) !== null;
    });
  } catch (error) {
    if (!(error instanceof postgres.PostgresError) || error.code !== '55P03') throw error;
    return false;
  } finally {
    await revoker.close();
  }
}

/** The agent's `body` started while task A's review row is held, `revoke` run while it waits. */
async function whileParked(
  body: Readonly<Record<string, unknown>>,
  delegation: ReviewDelegation,
  revoke: (tx: TenantQuery) => Promise<unknown>,
) {
  const reviewId = String(detailOf(await w.open(w.ava))['reviewId']);
  const holder = await holdRows(s, 'reviews', [reviewId]);
  const running = w.world.asAgent({ operationId: randomUUID(), ...body }, delegation.credential);
  let revoked: boolean;
  try {
    await awaitParked(s, 'reviews', 1);
    revoked = await revokeElsewhere(revoke);
  } finally {
    await holder.release();
  }
  return { revoked, code: codeOf(await running) };
}

const OPEN = { command: 'review.open', pageUrl: PAGE, path: ABOUT, sourceRevision: 'agent-rev' };

describe.skipIf(serverUrl === undefined)(
  'C35 review:write under a delegation, after the wait',
  () => {
    it('refuses an open whose delegation was revoked while it waited on the review', async () => {
      const { delegation } = await delegatingPerson('gil');
      const revisions = await w.count('review_revisions', w.world.business);
      const raced = await whileParked(
        { ...OPEN, taskId: w.taskA },
        delegation,
        async (tx) => await revokeDelegation(tx, delegation.id),
      );
      // The setup open adds one revision; the agent's adds none.
      expect({
        ...raced,
        revisions: await w.count('review_revisions', w.world.business),
      }).toStrictEqual({ revoked: true, code: 'DELEGATION_NOT_LIVE', revisions: revisions + 1 });
    });

    it('refuses an open whose person lost review:write while it waited on the review', async () => {
      const { grantId, delegation } = await delegatingPerson('hal');
      const revisions = await w.count('review_revisions', w.world.business);
      const raced = await whileParked(
        { ...OPEN, taskId: w.taskA },
        delegation,
        async (tx) => await revokeGrant(tx, grantId),
      );
      expect({
        revoked: raced.revoked,
        revisions: await w.count('review_revisions', w.world.business),
      }).toStrictEqual({ revoked: true, revisions: revisions + 1 });
      // A grant revoked under a delegation may revoke the delegation too (authority lost).
      expect(raced.code).toMatch(/^DELEGATION_(NARROWED|NOT_LIVE)$/u);
    });

    it('refuses a capture whose delegation was revoked while it waited on the review', async () => {
      const { delegation } = await delegatingPerson('ivy');
      const revisionId = detailOf(await w.open(w.ava))['revisionId'];
      const captures = await w.count('review_captures', w.world.business);
      const raced = await whileParked(
        { command: 'review.capture', revisionId },
        delegation,
        async (tx) => await revokeDelegation(tx, delegation.id),
      );
      expect({
        ...raced,
        captures: await w.count('review_captures', w.world.business),
      }).toStrictEqual({ revoked: true, code: 'DELEGATION_NOT_LIVE', captures });
    });
  },
);
