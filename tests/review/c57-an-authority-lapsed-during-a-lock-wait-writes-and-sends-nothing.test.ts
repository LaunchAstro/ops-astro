// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop, no-promise-executor-return, max-lines-per-function, unicorn/no-useless-undefined -- Sol's proofs kept whole: each polls the database until the lock or the expiry it waits for */
//
// C57 (#2017): authority is judged after the lock waits, not before (Sol's PR #2160 proofs, kept
// whole). A lease or mandate that lapses while the shepherd or the broker waits writes and sends nothing.

import { describe, expect, it } from 'vitest';
import { advisoryLock } from '../../packages/core-records/src/index.ts';
import {
  attemptsOf,
  footprint,
  itemOf,
  mandateEnding,
  noDatabase,
  on,
  ownPool,
  raisedScene,
  runOf,
  scene,
  send,
  shepherd,
  useShepherdWorld,
  w,
} from './shepherd-world.ts';

useShepherdWorld('sol2160expiry');

async function waitForLock(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await w.db.admin.execute<{ waiting: boolean }>(
      `select exists (select 1 from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock') as waiting`,
    );
    if (row?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the product call did not reach the held lock');
}

async function waitUntilExpired(table: 'leases' | 'standing_mandates', id: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await w.db.admin.execute<{ expired: boolean }>(
      `select expires_at <= clock_timestamp() as expired from public.${table} where id = $1`,
      [id],
    );
    if (row?.expired) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the authority never expired');
}

describe.skipIf(noDatabase)('C57 authority lapsed during a lock wait', () => {
  it('C57 a lease expired during the review lock wait writes nothing', async () => {
    const s = await scene();
    const run = await runOf();
    const before = await footprint();
    const holder = ownPool();
    const worker = ownPool();
    let pending: ReturnType<typeof shepherd> | undefined;
    try {
      await holder.withBusiness(on('alpha').business, async (tx) => {
        await tx.query(
          'select id from public.reviews where business_id = $1 and id = $2 for update',
          [tx.businessId, s.review],
        );
        await w.db.admin.execute(
          `update public.leases set expires_at = clock_timestamp() + interval '2 seconds' where id = $1`,
          [run.lease.leaseId],
        );
        pending = shepherd(run, s.review, { database: worker });
        await waitForLock();
        await waitUntilExpired('leases', run.lease.leaseId);
      });
      const answer = await pending;
      const after = await footprint();
      expect({ answer, after }).toStrictEqual({
        answer: { kind: 'refused', code: 'LEASE_NOT_OWNED' },
        after: before,
      });
    } finally {
      await pending?.catch(() => undefined);
      await worker.close();
      await holder.close();
    }
  });

  it('C57 a lease expired during the task foreign-key lock wait writes nothing', async () => {
    const s = await scene();
    const run = await runOf();
    const before = await footprint();
    const holder = ownPool();
    const worker = ownPool();
    let pending: ReturnType<typeof shepherd> | undefined;
    try {
      await holder.withBusiness(on('alpha').business, async (tx) => {
        await tx.query(
          'select id from public.records where business_id = $1 and id = $2 for update',
          [tx.businessId, s.task],
        );
        await w.db.admin.execute(
          `update public.leases set expires_at = clock_timestamp() + interval '2 seconds' where id = $1`,
          [run.lease.leaseId],
        );
        pending = shepherd(run, s.review, { database: worker });
        await waitForLock();
        await waitUntilExpired('leases', run.lease.leaseId);
      });
      const answer = await pending;
      const after = await footprint();
      expect({ answer, after }).toStrictEqual({
        answer: { kind: 'refused', code: 'LEASE_NOT_OWNED' },
        after: before,
      });
    } finally {
      await pending?.catch(() => undefined);
      await worker.close();
      await holder.close();
    }
  });

  it('C57 a lease expired during the audit-chain lock wait writes nothing', async () => {
    const s = await scene();
    const run = await runOf();
    const before = await footprint();
    const holder = ownPool();
    const worker = ownPool();
    let pending: ReturnType<typeof shepherd> | undefined;
    try {
      await holder.withBusiness(on('alpha').business, async (tx) => {
        await advisoryLock(tx, tx.businessId);
        await w.db.admin.execute(
          `update public.leases set expires_at = clock_timestamp() + interval '2 seconds' where id = $1`,
          [run.lease.leaseId],
        );
        pending = shepherd(run, s.review, { database: worker });
        await waitForLock();
        await waitUntilExpired('leases', run.lease.leaseId);
      });
      const answer = await pending;
      const after = await footprint();
      expect({ answer, after }).toStrictEqual({
        answer: { kind: 'refused', code: 'LEASE_NOT_OWNED' },
        after: before,
      });
    } finally {
      await pending?.catch(() => undefined);
      await worker.close();
      await holder.close();
    }
  });

  it('C57 a mandate expired during the weekly window lock wait sends nothing', async () => {
    const { scene: s, raised } = await raisedScene();
    const item = await itemOf(raised, s.recipient.personId);
    const mandateId = await mandateEnding('alpha', s.client, 2);
    const holder = ownPool();
    const received = w.provider.received.length;
    let pending: ReturnType<typeof send> | undefined;
    try {
      await holder.withBusiness(on('alpha').business, async (tx) => {
        await advisoryLock(tx, `aw07b:client:${tx.businessId}:${s.client}`);
        pending = send('alpha', item);
        await waitForLock();
        await waitUntilExpired('standing_mandates', mandateId);
      });
      const answer = await pending;
      expect({
        answer,
        calls: w.provider.received.length - received,
        attempts: await attemptsOf(item),
      }).toStrictEqual({
        answer: { ok: false, code: 'SEND_NOT_APPROVED' },
        calls: 0,
        attempts: [],
      });
    } finally {
      await pending?.catch(() => undefined);
      await holder.close();
    }
  });
});
