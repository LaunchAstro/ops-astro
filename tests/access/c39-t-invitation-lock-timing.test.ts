// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop -- each wait observes the preceding database state */
/* eslint-disable max-lines-per-function -- each proof holds its lock schedule in one place */
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { advisoryLock, connect } from '../../packages/core-records/src/tenancy/database.ts';
import { sendInvitation } from '../../packages/core-custody/src/index.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import {
  addressFor,
  c,
  invite,
  as,
  codeOf,
  MAIL,
  noDatabase,
  send,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

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

async function pastExpiry<T>(id: string, run: () => Promise<T>): Promise<T> {
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
    await tx.query('select id from invitations where id = $1 for update', [id]);
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
  'C39-T expiry and the email ceiling, judged when the lock is granted',
  () => {
    it('a send waiting for the invitation lock refuses after its expiry', async () => {
      const id = await invite(c.admin);
      const before = w.provider.received.length;
      const result = await pastExpiry(id, async () => await send(id));
      expect(result).toStrictEqual({ ok: false, code: 'INVITATION_NOT_PENDING' });
      expect(w.provider.received.length).toBe(before);
    });

    it('an administrator invitation waiting at the address limiter is refused once its inviter loses access:manage', async () => {
      // Sol PRV-oa-1018-R1.1: authority is asked again once the limiter is held.
      const inviter = await enrol(w.db.app, w.alpha, 'Pat Promoted');
      const manage = await w.db.app.withBusiness(w.alpha, async (tx) => {
        await grantTo(tx, inviter, 'share', undefined, false, 'access');
        return await grantTo(tx, inviter, 'manage', undefined, false, 'access');
      });
      const address = addressFor('promoted');
      const blocker = connect(w.db.appUrl);
      const held = latch();
      const release = latch();
      let pid = 0;
      const holding = blocker.withBusiness(w.alpha, async (tx) => {
        const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
        pid = row?.pid ?? 0;
        await advisoryLock(tx, `limit:${w.alpha}:invitation:address:${address}`);
        held.release();
        await release.promise;
      });
      let result: Awaited<ReturnType<typeof as>> | undefined;
      try {
        await held.promise;
        const running = as(inviter, 'invitation.create', {
          name: 'Ivy Admin',
          email: address,
          role: 'admin',
        });
        await waitUntil(async () => {
          const [row] = await w.db.admin.execute<{ ready: boolean }>(
            'select exists (select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))) as ready',
            [pid],
          );
          return row?.ready === true;
        });
        expect(codeOf(await as(c.admin, 'access.revoke', { grantId: manage }))).toBe('applied');
        release.release();
        result = await running;
      } finally {
        release.release();
        await holding;
        await blocker.close();
      }
      expect(codeOf(result)).toBe('SCOPE_NOT_GRANTED');
      const [made] = await w.db.admin.execute<{ n: number }>(
        'select count(*)::int as n from public.invitations where address = $1',
        [address],
      );
      expect(made?.n).toBe(0);
    });

    it('a create waiting at the address limiter replaces an invitation that lapsed meanwhile', async () => {
      // Sol PRV-oa-1018-R1.5: expiry is judged once the create holds its locks.
      const address = addressFor('lapsing');
      const id = await invite(c.admin, address);
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
        await advisoryLock(tx, `limit:${w.alpha}:invitation:address:${address}`);
        held.release();
        await release.promise;
      });
      try {
        await held.promise;
        const running = as(c.admin, 'invitation.create', {
          name: 'Ivy Again',
          email: address,
          role: 'member',
        });
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
        expect(codeOf(await running)).toBe('applied');
      } finally {
        release.release();
        await holding;
        await blocker.close();
      }
      const rows = await w.db.admin.execute<{ id: string; state: string }>(
        'select id, state from public.invitations where address = $1 order by created_at',
        [address],
      );
      expect(rows.map((row) => row.state)).toStrictEqual(['expired', 'pending']);
      expect(rows[0]?.id).toBe(id);
    });

    it('a resend waiting for the invitation lock cannot revive a lapsed invitation', async () => {
      const id = await invite(c.admin);
      const result = await pastExpiry(
        id,
        async () => await as(c.admin, 'invitation.resend', { invitationId: id }),
      );
      expect(codeOf(result)).toBe('TRANSITION_NOT_PERMITTED');
    });

    it('asks delayed by row locks still occupy the email ceiling when dispatch starts', async () => {
      const ids: string[] = [];
      for (let n = 0; n < 5; n += 1) ids.push(await invite(c.admin));
      const blocker = connect(w.db.appUrl);
      const senders = connect(w.db.appUrl, { max: 5 });
      const held = latch();
      const release = latch();
      const entered = latch();
      let pid = 0;
      let calls = 0;
      let active = 0;
      let peak = 0;
      w.provider.mode('slow');
      const custody: typeof w.custody = {
        ...w.custody,
        dispatch: async (ref, request) => {
          calls += 1;
          active += 1;
          peak = Math.max(peak, active);
          if (calls === 4) entered.release();
          try {
            return await w.custody.dispatch(ref, request);
          } finally {
            active -= 1;
          }
        },
      };
      const holding = blocker.withBusiness(w.alpha, async (tx) => {
        const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
        pid = row?.pid ?? 0;
        await tx.query(
          'select id from invitations where id = any($1::uuid[]) order by id for update',
          [ids.slice(0, 4)],
        );
        held.release();
        await release.promise;
      });
      const running: Promise<unknown>[] = [];
      try {
        await held.promise;
        for (const id of ids.slice(0, 4))
          running.push(sendInvitation(senders, w.alpha, id, { ...w.broker, custody }, MAIL));
        await waitUntil(async () => {
          const [row] = await w.db.admin.execute<{ n: number }>(
            'select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
            [pid],
          );
          return row?.n === 4;
        });
        await delay(61_000);
        release.release();
        await entered.promise;
        const fifth = sendInvitation(
          senders,
          w.alpha,
          ids[4] ?? '',
          { ...w.broker, custody },
          MAIL,
        );
        running.push(fifth);
        const result = await fifth;
        expect(peak, 'simultaneous dispatches through real custody').toBeLessThanOrEqual(4);
        expect(result).toStrictEqual({ ok: false, code: 'EMAIL_AT_CEILING' });
      } finally {
        release.release();
        await Promise.allSettled(running);
        await holding;
        await blocker.close();
        await senders.close();
      }
    }, 90_000);
  },
);
