// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2011): two workers claim the same revision's capture at once, each on a connection
// of its own, so each claim is a transaction of its own. A third connection holds the capture
// rows until both claims are in flight and waiting on a lock; then it lets go. Exactly one
// claim applies, and the other, served after the first commits, finds the rows claimed under
// a live lease and is refused CAPTURE_NOT_CLAIMABLE.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { readAuditEvents } from '../../packages/core-commands/src/commands/audit.ts';
import {
  c35World,
  capturesOf,
  pickUpReviewed,
  underLease,
  underReview,
  type C35World,
} from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 claim race: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35race');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** Backends of this database parked on a lock, whatever lock it is. */
const parked = async (): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
      )
    )[0]?.n,
  );

async function untilParked(count: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    if ((await parked()) >= count) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`fewer than ${String(count)} claims ever waited: they never ran at once`);
}

describe.skipIf(serverUrl === undefined)('C35 the claim race', () => {
  it('C35 two workers claiming one capture at once leave exactly one claim', async () => {
    const reviewed = await underReview(w, 'two workers, one capture');
    const lease = await pickUpReviewed(w, reviewed);

    // Three pools, so the holder and each racer is a backend of its own.
    const holderDb = connect(w.world.db.appUrl, { source: 'racer' });
    const firstDb = connect(w.world.db.appUrl, { source: 'racer' });
    const secondDb = connect(w.world.db.appUrl, { source: 'racer' });
    try {
      let locked!: () => void;
      let release!: () => void;
      const lockedNow = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = holderDb.withBusiness(w.world.business, async (tx) => {
        await tx.query(
          `select 1 from public.review_captures
            where business_id = $1 and revision_id = $2 for update`,
          [w.world.business, reviewed.revisionId],
        );
        locked();
        await gate;
      });
      await lockedNow;

      const claim = { command: 'review.capture_claim', revisionId: reviewed.revisionId };
      const first = underLease(w, lease, claim, firstDb);
      const second = underLease(w, lease, claim, secondDb);
      await untilParked(2);
      release();
      await holding;
      const answers = [await first, await second];

      const codes = answers.map((answer) => codeOf(answer.result)).toSorted();
      expect(codes).toStrictEqual(['CAPTURE_NOT_CLAIMABLE', 'not-a-refusal']);
      const won = answers.find((answer) => codeOf(answer.result) === 'not-a-refusal');
      const lost = answers.find((answer) => codeOf(answer.result) !== 'not-a-refusal');
      expect(detailOf(won!.result)).toStrictEqual({
        revisionId: reviewed.revisionId,
        widths: [390, 1480],
      });

      // The refused claim was answered after the applied one committed: its audit row follows.
      const events = await w.world.db.app.withBusiness(
        w.world.business,
        async (tx) => await readAuditEvents(tx),
      );
      const seqOf = (operationId: string) =>
        BigInt(events.find((event) => event.operation_id === operationId)?.seq ?? '0');
      expect(seqOf(won!.operationId)).toBeGreaterThan(0n);
      expect(seqOf(lost!.operationId)).toBeGreaterThan(seqOf(won!.operationId));

      // One claim on the rows: both widths under the lease that won, at its fence.
      expect(await capturesOf(w, reviewed.revisionId)).toStrictEqual([
        {
          width: 1480,
          state: 'claimed',
          lease_id: lease.leaseId,
          picture_id: null,
          picture_digest: null,
        },
        {
          width: 390,
          state: 'claimed',
          lease_id: lease.leaseId,
          picture_id: null,
          picture_digest: null,
        },
      ]);
    } finally {
      await Promise.all([holderDb.close(), firstDb.close(), secondDb.close()]);
    }
  }, 60_000);
});
