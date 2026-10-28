// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function, no-await-in-loop, no-promise-executor-return -- Sol's proof kept as written: it polls the database one read at a time */
//
// Sol's proof for S2165-1 (#2075), kept as written but for its name and the lock it watches: a
// person's carry parks on a comment's lock (before the fix, the insert's foreign key on it;
// after, the comment's key-share lock taken before the lease is judged), the lease runs out on
// the database clock, and once released the carry is refused LEASE_EXPIRED with no carry.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c35World, underReview, type C35World } from './c35-world.ts';
import { pictureBytes } from './c35-landing.ts';
import { carriesOnto, must, nextRevision, observed, pinOn } from './c35-x-carry.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('sol2165lease');
}, 180_000);
afterAll(async () => {
  if (w) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('a person carry parked on a comment lock', () => {
  it('a person carry waiting on a comment past lease expiry writes no carry', async () => {
    const reviewed = await underReview(w, 'Sol person carry after expiry');
    const [row] = await w.world.db.admin.execute<{ revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [reviewed.taskId],
    );
    const proposed = must(
      await w.as(w.ava, {
        command: 'task.propose',
        recordId: reviewed.taskId,
        expectedRevision: Number(row?.revision),
        purpose: 'sol2165_capture',
        maximumMinor: 3000,
        currency: 'AUD',
        payload: { instruction: 'capture only' },
        step: { kind: 'compose', payload: {} },
      }),
      'propose',
    );
    const decided = must(
      await w.as(w.ava, {
        command: 'task.decide',
        gateId: proposed['gateId'],
        versionId: proposed['versionId'],
        decision: 'approve',
        note: 'local fixture only',
      }),
      'decide',
    );
    const picked = must(
      await w.as(w.ava, {
        command: 'task.pickup',
        reservationId: decided['reservationId'],
        leaseSeconds: 15,
      }),
      'person pickup',
    );
    const lease = { leaseId: picked['leaseId'], fence: picked['fence'] };
    const land = async (revisionId: string) => {
      must(await w.as(w.ava, { command: 'review.capture_claim', ...lease, revisionId }), 'claim');
      for (const width of [1480, 390]) {
        must(
          await w.as(w.ava, {
            command: 'review.capture_land',
            ...lease,
            revisionId,
            width,
            picture: pictureBytes(width).toString('base64'),
            observation: observed(width, { text: 'hello', document: 'a' }),
          }),
          'land',
        );
      }
    };
    await land(reviewed.revisionId);
    const commentId = await pinOn(w, reviewed.revisionId);
    const next = await nextRevision(w, reviewed);
    await land(next);
    const blocker = connect(w.world.db.appUrl);
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const locked = new Promise<void>((r) => {
      ready = r;
    });
    const held = blocker.withBusiness(w.world.business, async (tx) => {
      await tx.query('select 1 from public.records where business_id = $1 and id = $2 for update', [
        w.world.business,
        commentId,
      ]);
      ready();
      await gate;
    });
    await locked;
    const carrying = w.as(w.ava, { command: 'review.carry_pins', ...lease, revisionId: next });
    try {
      let parked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const [waiting] = await w.world.db.admin.execute<{ n: string }>(
          `select count(*)::text as n from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and (query like '%insert into public.review_pin_carries%'
            or query like '%from public.records%for key share%')`,
        );
        if (Number(waiting?.n) > 0) {
          parked = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(parked, 'carry reached the comment lock wait').toBe(true);
      let expired = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        const [expiry] = await w.world.db.admin.execute<{ expired: boolean }>(
          'select expires_at <= clock_timestamp() as expired from public.leases where id = $1',
          [lease.leaseId],
        );
        if (expiry?.expired) {
          expired = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(expired, 'lease expired before the blocked insert was released').toBe(true);
    } finally {
      release();
      await held;
      await blocker.close();
    }
    const result = await carrying;
    expect({
      code: codeOf(result),
      detail: detailOf(result),
      carries: await carriesOnto(w, next),
    }).toMatchObject({ code: 'LEASE_EXPIRED', carries: [] });
  }, 90_000);
});
