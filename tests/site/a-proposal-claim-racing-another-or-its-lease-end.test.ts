// SPDX-License-Identifier: AGPL-3.0-only
//
// A correction's proposal is claimed under its live worker lease, with the
// correction row locked first. Two claims at once, each on a connection of its
// own, write one row: the second waits for the first, then finds its row and
// claims nothing. A claim racing the lease's end, in either order, waits on the
// other: the lease ended first leaves nothing claimed; the claim first stands,
// and the end waits for it. Each wait is seen in pg_stat_activity.

import { describe, expect, it } from 'vitest';
import { claimProposal } from '../../packages/core-records/src/index.ts';
import { endLease } from '../../packages/core-runtime/src/recovery/lease-retirement.ts';
import { approved, at, lease, serverUrl, useRegisterWorld, w } from './c80-register-world.ts';
import { held, onOwn, waitSeen } from './party-site-races.ts';

useRegisterWorld();

/** The correction's row read for the lease check, locked for update. */
const CORRECTION_LOCK = /from public\.live_corrections c\s+where[\s\S]*for update of c/u;
/** The lease share-locked by the claim. */
const LEASE_SHARE = /from public\.leases l\s+where[\s\S]*for share of l/u;
const LEASE_END = /update public\.leases set state = \$3/u;

async function rowsOf(id: string): Promise<readonly { state: string }[]> {
  return await w.world.db.admin.execute<{ state: string }>(
    'select state from public.live_correction_proposals where correction_id = $1',
    [id],
  );
}

async function leaseLiveAgain(): Promise<void> {
  await w.world.db.admin.execute(
    `update public.leases set state = 'live', released_at = null,
        expires_at = now() + interval '1 hour' where id = $1`,
    [lease.leaseId],
  );
}

const claim = (id: string) => onOwn(w, async (tx) => await claimProposal(tx, at(id), 'blob-base'));

describe.skipIf(serverUrl === undefined)('two claims of one proposal at once', () => {
  it('write one row: the second waits for the first, then finds it and claims nothing', async () => {
    const id = await approved();
    const first = held(w, async (tx) => await claimProposal(tx, at(id), 'blob-base'));
    expect(await first.ready).toMatchObject({ ok: true, fresh: true });
    const second = claim(id);
    await waitSeen(w, CORRECTION_LOCK);
    first.release();
    await first.done;
    expect(await second).toMatchObject({ ok: true, fresh: false, proposal: { state: 'claimed' } });
    expect(await rowsOf(id)).toEqual([{ state: 'claimed' }]);
  });
});

describe.skipIf(serverUrl === undefined)("a claim racing its lease's end", () => {
  it('the lease ended first: the claim waits for the end, then claims nothing', async () => {
    const id = await approved();
    const ending = held(w, async (tx) => {
      await endLease(tx, lease.leaseId, 'released');
    });
    await ending.ready;
    const claiming = claim(id);
    await waitSeen(w, LEASE_SHARE);
    ending.release();
    await ending.done;
    try {
      expect(await claiming).toEqual({ ok: false, code: 'LEASE_NOT_OWNED' });
      expect(await rowsOf(id)).toEqual([]);
    } finally {
      await leaseLiveAgain();
    }
  });

  it('the claim first: the end waits for the claim, and the claim stands', async () => {
    const id = await approved();
    const claiming = held(w, async (tx) => await claimProposal(tx, at(id), 'blob-base'));
    expect(await claiming.ready).toMatchObject({ ok: true, fresh: true });
    const ending = onOwn(w, async (tx) => {
      await endLease(tx, lease.leaseId, 'released');
    });
    try {
      await waitSeen(w, LEASE_END);
      claiming.release();
      await claiming.done;
      await ending;
      expect(await rowsOf(id)).toEqual([{ state: 'claimed' }]);
      const [ended] = await w.world.db.admin.execute<{ state: string }>(
        'select state from public.leases where id = $1',
        [lease.leaseId],
      );
      expect(ended?.state).toBe('released');
    } finally {
      await leaseLiveAgain();
    }
  });
});
