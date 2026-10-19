// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2011): the worker's claim and land each leave one applied audit row, in the
// business's one chain. The claim's row names the revision it claimed; the land's names the
// capture row it landed, and that row is the one the claiming lease holds. Both are the
// agent's own acting identity, in order, linked to the row before each, and the chain still
// adds up.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import {
  readAuditEvents,
  verifyAuditChain,
} from '../../packages/core-commands/src/commands/audit.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  c35World,
  landUnder,
  pickUpReviewed,
  pictureBytes,
  underLease,
  underReview,
  type C35World,
} from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 land audit: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35landaudit');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C35 the land in the audit chain', () => {
  it("C35 a capture land leaves its audit row in the business's chain", async () => {
    const reviewed = await underReview(w, 'a land in the chain');
    const lease = await pickUpReviewed(w, reviewed);
    const claim = await underLease(w, lease, {
      command: 'review.capture_claim',
      revisionId: reviewed.revisionId,
    });
    expect(codeOf(claim.result)).toBe('not-a-refusal');
    const land = await landUnder(w, lease, {
      revisionId: reviewed.revisionId,
      width: 1480,
      picture: pictureBytes(21),
    });
    if (isCommandRefusal(land.result)) throw new Error(`the land was refused ${land.result.code}`);
    const captureId = String(land.result.recordId);

    // The landed row is the 1480 capture of this revision, under the lease that claimed it.
    const [row] = await w.world.db.admin.execute<{
      readonly revision_id: string;
      readonly width: number;
      readonly state: string;
      readonly lease_id: string;
      readonly fence: string;
    }>(
      `select revision_id, width, state, lease_id, fence::text as fence
         from public.review_captures where business_id = $1 and id = $2`,
      [w.world.business, captureId],
    );
    expect(row).toStrictEqual({
      revision_id: reviewed.revisionId,
      width: 1480,
      state: 'landed',
      lease_id: lease.leaseId,
      fence: String(lease.fence),
    });

    const { events, report } = await w.world.db.app.withBusiness(w.world.business, async (tx) => ({
      events: await readAuditEvents(tx),
      report: await verifyAuditChain(tx),
    }));
    const at = (operationId: string) => events.findIndex((one) => one.operation_id === operationId);
    const claimAt = at(claim.operationId);
    const landAt = at(land.operationId);
    expect(claimAt).toBeGreaterThan(0);
    expect(landAt).toBeGreaterThan(claimAt);
    expect(events.filter((one) => one.operation_id === land.operationId)).toHaveLength(1);

    expect(events[claimAt]).toMatchObject({
      command: 'review.capture_claim',
      outcome: 'applied',
      refusal_code: null,
      actor_id: w.world.agentActorId,
      subject_record_id: reviewed.revisionId,
    });
    expect(events[landAt]).toMatchObject({
      command: 'review.capture_land',
      outcome: 'applied',
      refusal_code: null,
      actor_id: w.world.agentActorId,
      subject_record_id: captureId,
    });

    // Each linked to the row before it, in an unbroken chain.
    for (const index of [claimAt, landAt]) {
      expect(BigInt(events[index]?.seq ?? '0')).toBe(BigInt(events[index - 1]?.seq ?? '0') + 1n);
      expect(events[index]?.prev_hash).toBe(events[index - 1]?.hash);
    }
    expect(report.intact).toBe(true);
  }, 60_000);
});
