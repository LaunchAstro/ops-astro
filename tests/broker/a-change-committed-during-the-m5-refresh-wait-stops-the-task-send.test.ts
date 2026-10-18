// SPDX-License-Identifier: AGPL-3.0-only
//
// Final authority after the last wait (#1703, #1620 P5, criterion 2): the
// model agent accepts a plan call only after custody has prepared the plan's
// token, which may wait on a refresh. Whatever commits during that wait is
// judged at the send, after it: a client linked to the task, the run's
// delegation revoked or past its expiry, the calling agent's session ended,
// or its lease handed on, and the request is never sent. With nothing
// changed, the same call is sent.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endProviderSession } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { liveWork, type Work } from '../runtime/schedules-harness.ts';
import { rowsOf, s, useBrokerWorld } from './broker-world.ts';
import { carriedCall, openCarriedTaskWorld, type CarriedTaskWorld } from './carried-task-world.ts';

const serverUrl = databaseUrlFromEnvironment();

useBrokerWorld('carrywait');

describe.skipIf(serverUrl === undefined)('a change committed during the refresh wait', () => {
  let world: CarriedTaskWorld;

  beforeAll(async () => {
    world = await openCarriedTaskWorld();
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  /** The work's call, with `change` committed while the model agent prepares; what was sent. */
  async function callWith(work: Work, change: () => Promise<void>) {
    let ran = false;
    world.duringPrepare = async () => {
      if (ran) return;
      ran = true;
      await change();
    };
    const sent = world.plan.sent.length;
    try {
      const answer = await carriedCall(world, work);
      const [row] = await rowsOf(answer.callId);
      return { answer, ran, sent: world.plan.sent.length - sent, state: row?.['state'] };
    } finally {
      world.duringPrepare = async () => {};
    }
  }

  const fresh = async (title: string): Promise<Work> =>
    await liveWork(s, `${title} ${randomUUID()}`, 2_000);

  it('stops the send when a client is linked to the task during the wait', async () => {
    const work = await fresh('Client link mid-wait');
    const called = await callWith(work, async () => {
      await s.db.admin.execute(
        `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
        [work.taskId, randomUUID()],
      );
    });
    expect(called).toMatchObject({ ran: true, sent: 0, state: 'released' });
    expect(called.answer).toMatchObject({ ok: false });
  }, 60_000);

  it("stops the send when the run's delegation is revoked during the wait", async () => {
    const work = await fresh('Delegation revoked mid-wait');
    const called = await callWith(work, async () => {
      await s.db.admin.execute(
        `update public.delegations set revoked_at = clock_timestamp() where id = $1`,
        [work.picked['delegationId']],
      );
    });
    expect(called).toMatchObject({ ran: true, sent: 0, state: 'released' });
  }, 60_000);

  it("stops the send when the run's delegation expires during the wait", async () => {
    const work = await fresh('Delegation expiring mid-wait');
    await s.db.admin.execute(
      `update public.delegations set expires_at = clock_timestamp() + interval '1500 milliseconds'
        where id = $1`,
      [work.picked['delegationId']],
    );
    const called = await callWith(work, async () => {
      await sleep(2_500);
    });
    expect(called).toMatchObject({ ran: true, sent: 0, state: 'released' });
  }, 60_000);

  it('stops the send when the lease is handed on during the wait', async () => {
    const work = await fresh('Lease moved mid-wait');
    const called = await callWith(work, async () => {
      await s.db.admin.execute(`update public.leases set fence = fence + 1 where id = $1`, [
        work.picked['leaseId'],
      ]);
    });
    expect(called).toMatchObject({ ran: true, sent: 0, state: 'released' });
  }, 60_000);

  it('control: with nothing changed during the wait, the call is sent', async () => {
    const work = await fresh('Nothing changed mid-wait');
    const called = await callWith(work, async () => {
      await sleep(500);
    });
    expect(called).toMatchObject({ ran: true, sent: 1, state: 'settled' });
  }, 60_000);
  // Last: the world's calling agent keeps this one session, which stays ended.
  it("stops the send when the calling agent's session ends during the wait", async () => {
    const work = await fresh('Session ended mid-wait');
    const called = await callWith(work, async () => {
      await s.db.app.withBusiness(s.business, async (tx) => {
        await endProviderSession(tx, String(world.presented.sessionId));
      });
    });
    expect(called).toMatchObject({ ran: true, sent: 0, state: 'released' });
  }, 60_000);
});
