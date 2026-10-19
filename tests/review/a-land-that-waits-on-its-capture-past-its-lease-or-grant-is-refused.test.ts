// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2011, Sol S2121-1, S2121-2): a land re-judges its lease and the authority behind it
// after the capture lock wait. A person's land held on the capture row until its lease expires,
// and an agent's held until its delegating person's write grant expires, are refused and store
// nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, underReview, pickUpReviewed, type C35World } from './c35-world.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import {
  observationOf,
  pictureBytes,
  storedObjects,
  claimUnder,
  landUnder,
} from './c35-landing.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('sol2121wait');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

// eslint-disable-next-line max-lines-per-function -- one world, and the two waits that share it
describe.skipIf(serverUrl === undefined)('C35 a land that waited on its capture', () => {
  // eslint-disable-next-line max-lines-per-function -- Sol's proof whole, as round 1 ran it
  it('a person’s land that waited on its capture past the lease’s expiry is refused and stores nothing', async () => {
    const reviewed = await underReview(w, 'Sol expired while waiting');
    const [task] = await w.world.db.admin.execute<{ revision: string }>(
      'select revision::text from records where id=$1',
      [reviewed.taskId],
    );
    const proposal = detailOf(
      await w.as(w.ava, {
        command: 'task.propose',
        recordId: reviewed.taskId,
        expectedRevision: Number(task!.revision),
        purpose: 'sol_capture_wait',
        maximumMinor: 3000,
        currency: 'AUD',
        payload: { instruction: 'capture' },
        step: { kind: 'compose', payload: {} },
      }),
    );
    const decided = detailOf(
      await w.as(w.ava, {
        command: 'task.decide',
        gateId: proposal['gateId'],
        versionId: proposal['versionId'],
        decision: 'approve',
        note: 'proof',
      }),
    );
    const picked = detailOf(
      await w.as(w.ava, {
        command: 'task.pickup',
        reservationId: decided['reservationId'],
        leaseSeconds: 4,
      }),
    );
    const lease = {
      leaseId: picked['leaseId'],
      fence: picked['fence'],
      revisionId: reviewed.revisionId,
    };
    expect(codeOf(await w.as(w.ava, { command: 'review.capture_claim', ...lease }))).toBe(
      'not-a-refusal',
    );
    const before = await storedObjects(w, w.world.business);
    const holder = connect(w.world.db.appUrl);
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((r) => {
      locked = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const held = holder.withBusiness(w.world.business, async (tx) => {
      await tx.query(
        'select 1 from review_captures where business_id=$1 and revision_id=$2 for update',
        [w.world.business, reviewed.revisionId],
      );
      locked();
      await gate;
    });
    await ready;
    let landing: ReturnType<typeof w.as> | undefined;
    try {
      landing = w.as(w.ava, {
        command: 'review.capture_land',
        ...lease,
        width: 1480,
        picture: pictureBytes(1).toString('base64'),
        observation: observationOf(1480),
      });
      // Observe the real handler blocked in its capture lookup, after lockOwnedLease returned.
      let parked = false;
      for (let i = 0; i < 200; i++) {
        // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
        const [row] = await w.world.db.admin.execute<{ n: string }>(
          "select count(*)::text n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%select k.id, k.state%'",
        );
        if (Number(row?.n) > 0) {
          parked = true;
          break;
        }
        // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
        await new Promise((r) => {
          setTimeout(r, 25);
        });
      }
      expect(parked, 'land must reach the capture lock while its lease is live').toBe(true);
      for (let i = 0; i < 200; i++) {
        // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
        const [row] = await w.world.db.admin.execute<{ expired: boolean }>(
          'select expires_at <= clock_timestamp() as expired from leases where id=$1',
          [picked['leaseId']],
        );
        if (row?.expired) break;
        // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
        await new Promise((r) => {
          setTimeout(r, 50);
        });
      }
      release();
      await held;
      const answer = await landing;
      const [state] = await w.world.db.admin.execute<{ expired: boolean }>(
        'select expires_at <= clock_timestamp() as expired from leases where id=$1',
        [picked['leaseId']],
      );
      expect(state?.expired).toBe(true);
      expect({
        code: codeOf(answer),
        stored: await storedObjects(w, w.world.business),
      }).toStrictEqual({ code: 'LEASE_EXPIRED', stored: before });
    } finally {
      release();
      await held;
      if (landing) await landing;
      await holder.close();
    }
  }, 60_000);

  // eslint-disable-next-line max-lines-per-function -- Sol's proof whole, as round 1 ran it
  it('an agent’s land that waited on its capture past the delegating write grant’s expiry is refused and stores nothing', async () => {
    const reviewed = await underReview(w, 'Sol grant expires while waiting');
    const lease = await pickUpReviewed(w, reviewed);
    expect(codeOf(await claimUnder(w, lease, reviewed.revisionId))).toBe('not-a-refusal');
    await w.world.db.admin.execute(
      "update grants set expires_at=clock_timestamp()+interval '4 seconds' where id=$1",
      [w.ava.grants.write],
    );
    const before = await storedObjects(w, w.world.business);
    const holder = connect(w.world.db.appUrl);
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((r) => {
      locked = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const held = holder.withBusiness(w.world.business, async (tx) => {
      await tx.query(
        'select 1 from review_captures where business_id=$1 and revision_id=$2 for update',
        [w.world.business, reviewed.revisionId],
      );
      locked();
      await gate;
    });
    await ready;
    let landing: ReturnType<typeof landUnder> | undefined;
    try {
      landing = landUnder(w, lease, {
        revisionId: reviewed.revisionId,
        width: 1480,
        picture: pictureBytes(2),
      });
      let parked = false;
      for (let i = 0; i < 200; i++) {
        // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
        const [row] = await w.world.db.admin.execute<{ n: string }>(
          "select count(*)::text n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%select k.id, k.state%'",
        );
        if (Number(row?.n) > 0) {
          parked = true;
          break;
        }
        // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
        await new Promise((r) => {
          setTimeout(r, 25);
        });
      }
      expect(parked).toBe(true);
      for (let i = 0; i < 200; i++) {
        // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
        const [row] = await w.world.db.admin.execute<{ expired: boolean }>(
          'select expires_at<=clock_timestamp() as expired from grants where id=$1',
          [w.ava.grants.write],
        );
        if (row?.expired) break;
        // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
        await new Promise((r) => {
          setTimeout(r, 50);
        });
      }
      release();
      await held;
      const answer = (await landing).result;
      const [state] = await w.world.db.admin.execute<{ expired: boolean }>(
        'select expires_at<=clock_timestamp() as expired from grants where id=$1',
        [w.ava.grants.write],
      );
      expect(state?.expired).toBe(true);
      // A fresh call under exactly the same authority is correctly refused.
      expect(
        codeOf(
          (
            await landUnder(w, lease, {
              revisionId: reviewed.revisionId,
              width: 390,
              picture: pictureBytes(3),
            })
          ).result,
        ),
      ).toBe('DELEGATION_NARROWED');
      expect({
        code: codeOf(answer),
        stored: await storedObjects(w, w.world.business),
      }).toStrictEqual({ code: 'DELEGATION_NARROWED', stored: before });
    } finally {
      release();
      await held;
      if (landing) await landing;
      await holder.close();
    }
  }, 60_000);
});
