// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop -- each wait observes the preceding database state */
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { advisoryLock, connect } from '../../packages/core-records/src/tenancy/database.ts';
import { c, invite, as, codeOf, noDatabase, useInvitationWorld, w } from './c39-t-world.ts';

useInvitationWorld();

const releaseNothing = () => {};

function latch() {
  let release = releaseNothing;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitUntil(check: () => Promise<boolean>, milliseconds = 5000): Promise<void> {
  const until = Date.now() + milliseconds;
  while (!(await check())) {
    if (Date.now() >= until) throw new Error('Timed out waiting for the database schedule');
    await delay(20);
  }
}

async function pastExpiry<T>(id: string, limit: string, run: () => Promise<T>): Promise<T> {
  await w.db.admin.execute(
    "update public.invitations set expires_at = clock_timestamp() + interval '1500 milliseconds' where id = $1",
    [id],
  );
  const blocker = connect(w.db.appUrl);
  const held = latch();
  const release = latch();
  let pid = 0;
  const holding = blocker.withBusiness(w.alpha, async (tx) => {
    const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
    pid = row?.pid ?? 0;
    await advisoryLock(tx, `limit:${w.alpha}:invitation:${limit}`);
    held.release();
    await release.promise;
  });
  try {
    await held.promise;
    const running = run();
    await waitUntil(async () => {
      const [row] = await w.db.admin.execute<{ ready: boolean }>(
        `select clock_timestamp() > expires_at and exists (
           select 1 from pg_stat_activity where $2 = any(pg_blocking_pids(pid))) as ready
           from public.invitations where id = $1`,
        [id, pid],
      );
      return row?.ready === true;
    });
    release.release();
    return await running;
  } finally {
    release.release();
    await holding;
    await blocker.close();
  }
}

describe.skipIf(noDatabase)(
  'C39-T a resend judges expiry again once the limit locks are held',
  () => {
    it.each(['address', 'account'] as const)(
      'a resend waiting for the %s limit lock cannot revive a lapsed invitation',
      async (kind) => {
        const id = await invite(c.admin);
        const [before] = await w.db.admin.execute<{ address: string; revision: number }>(
          'select address, revision from public.invitations where id = $1',
          [id],
        );
        const limit =
          kind === 'address' ? `address:${before?.address ?? ''}` : `account:${c.admin.actorId}`;
        const result = await pastExpiry(
          id,
          limit,
          async () => await as(c.admin, 'invitation.resend', { invitationId: id }),
        );
        expect(codeOf(result)).toBe('TRANSITION_NOT_PERMITTED');
        const [after] = await w.db.admin.execute<{ revision: number }>(
          'select revision from public.invitations where id = $1',
          [id],
        );
        expect(after?.revision).toBe(before?.revision);
      },
    );
  },
);
