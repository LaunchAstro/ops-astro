// SPDX-License-Identifier: AGPL-3.0-only
//
// A delegation stores exactly the (collection, action) pairs checked at mint
// (ORCH25-SL12B-PAIRS), and pickup mints `run:write` only where the
// delegating person holds it (ORCH25-SL12B-RUN), through the real boundary and
// a fresh Postgres.
//
// The widening this guards against: a delegation stored as a product of
// collections and actions, minted for `run:write` beside the task's three
// actions, would read as covering `run:read` and `run:comment` too, and the
// call-time grant check would let them through the moment the person gained
// them. Minted before the person held `run:write`, it would cover that too.
// Each case asks the real route what the agent reaches (`session.capabilities`
// and the call-time check every agent command makes), not the stored row alone.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDelegatedAuthority,
  resolveDelegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import type { Action } from '../../packages/core-records/src/authority/grants.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { pickedUpOn, type PickedUp } from '../api/mp-6-1-checks-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
const TASK_PAIRS = ['task:comment', 'task:read', 'task:write'];

// eslint-disable-next-line max-lines-per-function -- one business, two pickups either side of a grant
describe.skipIf(serverUrl === undefined)('delegation pairs', () => {
  let c: Controls;
  /** Picked up while the delegating person held no `run` grant at all. */
  let before: PickedUp;
  /** Picked up once they held `run:write`, before they gained `run:read` and `run:comment`. */
  let after: PickedUp;

  beforeAll(async () => {
    c = await createControls('delegation_pairs');
    const { db, business } = c.fixture;
    before = await pickedUpOn(c, 'pairs_before');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, c.manager, 'write', undefined, false, 'run');
    });
    after = await pickedUpOn(c, 'pairs_after');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, c.manager, 'read', undefined, false, 'run');
      await grantTo(tx, c.manager, 'comment', undefined, false, 'run');
    });
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  async function storedPairs(work: PickedUp): Promise<readonly string[]> {
    const rows = await c.fixture.db.admin.execute<{ readonly pairs: readonly string[] }>(
      `select d.pairs from public.leases l
         join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
        where l.id = $1`,
      [work.leaseId],
    );
    return rows[0]?.pairs ?? [];
  }

  async function reached(work: PickedUp): Promise<readonly string[]> {
    const answer = await c.asAgent('session.capabilities', {}, work.credential);
    expect(answer.status).toBe(200);
    const grants = answer.body['grants'] as readonly { collection: string; action: string }[];
    return grants.map((grant) => `${grant.collection}:${grant.action}`).toSorted();
  }

  async function callOn(work: PickedUp, collection: string, action: Action) {
    return await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      const resolved = await resolveDelegation(tx, c.fixture.agentActorId, work.credential);
      if (!resolved.ok) throw new Error(`the delegation did not resolve: ${resolved.refusal.code}`);
      const reach = await checkDelegatedAuthority(tx, resolved.value, {
        collection,
        action,
        scope: { kind: 'record', id: work.taskId },
      });
      return reach.ok ? 'ok' : reach.refusal.code;
    });
  }

  it('delegation stores the pairs checked', async () => {
    expect(await storedPairs(after)).toStrictEqual(['run:write', ...TASK_PAIRS]);
    expect(await reached(after)).toStrictEqual(['run:write', ...TASK_PAIRS]);
    expect(await callOn(after, 'run', 'write')).toBe('ok');
  });

  it('later-gained widening refused', async () => {
    // The person now holds run:read and run:comment; the delegation minted
    // before they did never checked them, so it carries neither.
    expect(await callOn(after, 'run', 'read')).toBe('DELEGATION_OUT_OF_PURPOSE');
    expect(await callOn(after, 'run', 'comment')).toBe('DELEGATION_OUT_OF_PURPOSE');
    expect(await reached(after)).not.toContain('run:read');
    expect(await reached(after)).not.toContain('run:comment');
    // Nor does the one minted before they held run:write at all.
    expect(await callOn(before, 'run', 'write')).toBe('DELEGATION_OUT_OF_PURPOSE');
  });

  it('person without run:write cannot delegate it', async () => {
    // The pickup was not refused: the task's pairs minted without it.
    expect(await storedPairs(before)).toStrictEqual(TASK_PAIRS);
    expect(await reached(before)).toStrictEqual(TASK_PAIRS);
  });

  it('a pair is fixed at mint', async () => {
    const [row] = await c.fixture.db.admin.execute<{ readonly id: string }>(
      `select delegation_id as id from public.leases where id = $1`,
      [before.leaseId],
    );
    const widened = c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      await tx.query(
        `update public.delegations set pairs = array_append(pairs, 'run:write')
          where business_id = $1 and id = $2`,
        [tx.businessId, row?.id],
      );
    });
    await expect(widened).rejects.toThrow(/fixed at mint/u);
    expect(await storedPairs(before)).toStrictEqual(TASK_PAIRS);
  });
});
