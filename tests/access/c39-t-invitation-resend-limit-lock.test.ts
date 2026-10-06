// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop -- each wait observes the preceding database state */
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { advisoryLock, connect } from '../../packages/core-records/src/tenancy/database.ts';
import { lockAccess, type TenantQuery } from '../../packages/core-records/src/index.ts';
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

async function waitUntil(check: () => Promise<boolean>, milliseconds = 8000): Promise<void> {
  const until = Date.now() + milliseconds;
  while (!(await check())) {
    if (Date.now() >= until) throw new Error('Timed out waiting for the database schedule');
    await delay(20);
  }
}

interface Holder {
  readonly pid: number;
  readonly letGo: () => void;
  readonly close: () => Promise<void>;
}

/** `hold` taken on another connection in alpha, kept until `letGo` or `close`. */
async function holdOn(hold: (tx: TenantQuery) => Promise<void>): Promise<Holder> {
  const blocker = connect(w.db.appUrl);
  const held = latch();
  const release = latch();
  let pid = 0;
  const holding = blocker.withBusiness(w.alpha, async (tx) => {
    const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
    pid = row?.pid ?? 0;
    await hold(tx);
    held.release();
    await release.promise;
  });
  try {
    await Promise.race([held.promise, holding]);
  } catch (error) {
    await blocker.close();
    throw error;
  }
  return {
    pid,
    letGo: release.release,
    close: async () => {
      release.release();
      await holding;
      await blocker.close();
    },
  };
}

/** Whether `pid` holds a lock some other backend is waiting on. */
async function blocking(pid: number): Promise<boolean> {
  const [row] = await w.db.admin.execute<{ waiting: boolean }>(
    'select exists (select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))) as waiting',
    [pid],
  );
  return row?.waiting === true;
}

/**
 * `run` started while `hold` is held on another connection, seen waiting on it
 * while the invitation is still live, and let go only once it has lapsed.
 * The expiry it set, whether the wait was seen before it, then `run`'s answer.
 */
async function pastExpiry<T>(
  id: string,
  hold: (tx: TenantQuery) => Promise<void>,
  run: () => Promise<T>,
): Promise<{ saved: string; waitedLive: boolean; result: T }> {
  const [set] = await w.db.admin.execute<{ expires: string }>(
    `update public.invitations set expires_at = clock_timestamp() + interval '3 seconds'
      where id = $1 returning expires_at::text as expires`,
    [id],
  );
  const holder = await holdOn(hold);
  const lapsed = async (): Promise<boolean> => {
    const [row] = await w.db.admin.execute<{ lapsed: boolean }>(
      'select clock_timestamp() > expires_at as lapsed from public.invitations where id = $1',
      [id],
    );
    return row?.lapsed === true;
  };
  try {
    const running = run();
    let waitedLive = false;
    await waitUntil(async () => {
      const waiting = await blocking(holder.pid);
      waitedLive ||= waiting && !(await lapsed());
      return waiting;
    });
    await waitUntil(async () => (await blocking(holder.pid)) && (await lapsed()));
    holder.letGo();
    return { saved: set?.expires ?? '', waitedLive, result: await running };
  } finally {
    await holder.close();
  }
}

describe.skipIf(noDatabase)('C39-T a resend judges expiry again once its locks are held', () => {
  it.each(['address limit', 'account limit', 'access'] as const)(
    'a resend waiting for the %s lock cannot revive a lapsed invitation',
    async (kind) => {
      const id = await invite(c.admin);
      const [before] = await w.db.admin.execute<{ address: string; revision: number }>(
        'select address, revision from public.invitations where id = $1',
        [id],
      );
      const hold = async (tx: TenantQuery): Promise<void> => {
        if (kind === 'access') await lockAccess(tx);
        else {
          const key =
            kind === 'address limit'
              ? `address:${before?.address ?? ''}`
              : `account:${c.admin.actorId}`;
          await advisoryLock(tx, `limit:${w.alpha}:invitation:${key}`);
        }
      };
      const { saved, waitedLive, result } = await pastExpiry(
        id,
        hold,
        async () => await as(c.admin, 'invitation.resend', { invitationId: id }),
      );
      expect(waitedLive).toBe(true);
      expect(codeOf(result)).toBe('TRANSITION_NOT_PERMITTED');
      const [after] = await w.db.admin.execute<{
        revision: number;
        expires: string;
        state: string;
        resent: number;
      }>(
        `select revision, expires_at::text as expires, state,
                (select count(*)::int from public.audit_events
                  where subject_record_id = $1 and command = 'invitation.resend'
                    and outcome = 'applied') as resent
           from public.invitations where id = $1`,
        [id],
      );
      expect(after?.revision).toBe(before?.revision);
      expect(after?.state).toBe('pending');
      expect(after?.resent).toBe(0);
      expect(after?.expires).toBe(saved);
    },
  );
});

/**
 * `run` started while the access lock is held on another connection, seen
 * waiting on it, held a second longer, then let go. The database clock at the
 * moment of letting go, then `run`'s answer.
 */
async function pastAccessWait<T>(run: () => Promise<T>): Promise<{ letGo: string; result: T }> {
  const holder = await holdOn(async (tx) => {
    await lockAccess(tx);
  });
  try {
    const running = run();
    await waitUntil(async () => await blocking(holder.pid));
    await delay(1000);
    const [now] = await w.db.admin.execute<{ at: string }>('select clock_timestamp()::text as at');
    holder.letGo();
    return { letGo: now?.at ?? '', result: await running };
  } finally {
    await holder.close();
  }
}

/** Whether the invitation's expiry is at least 7 days after `letGo`. */
const lifetimeFrom = async (id: string, letGo: string): Promise<boolean | undefined> => {
  const [row] = await w.db.admin.execute<{ after: boolean }>(
    `select expires_at >= $2::timestamptz + interval '7 days' as after
       from public.invitations where id = $1`,
    [id, letGo],
  );
  return row?.after;
};

describe.skipIf(noDatabase)('C39-T a lifetime is set on the clock at the write', () => {
  it('a resend that waited for the access lock runs its 7 days from the write', async () => {
    const id = await invite(c.admin);
    const { letGo, result } = await pastAccessWait(
      async () => await as(c.admin, 'invitation.resend', { invitationId: id }),
    );
    expect(codeOf(result)).toBe('applied');
    expect(await lifetimeFrom(id, letGo)).toBe(true);
  });

  it('a create that waited for the access lock runs its 7 days from the write', async () => {
    const { letGo, result } = await pastAccessWait(async () => await invite(c.admin));
    expect(await lifetimeFrom(result, letGo)).toBe(true);
  });
});
