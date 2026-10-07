// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T: an invitation's send keeps the promise the shared email ceiling rests
// on, as the inbox send does. A sender paused after its ask past the fence, on
// either host clock, calls no provider and records `failed`, evidence
// `expired`; one inside it still sends. And an invitation that expires while
// its send waits on the business's email limit lock sends nothing and mints
// no token.

import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IN_FLIGHT_GRACE_MS } from '../../packages/core-custody/src/email-class.ts';
import { sendInvitation } from '../../packages/core-custody/src/index.ts';
import { EMAIL_SEND } from '../../packages/core-connectors/src/index.ts';
import { advisoryLock, connect, type Database } from '../../packages/core-records/src/index.ts';
import {
  c,
  countFor,
  invite,
  MAIL,
  noDatabase,
  received,
  send,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

useInvitationWorld();

afterEach(() => {
  vi.restoreAllMocks();
});

const releaseNothing = (): void => {};

function latch(): { promise: Promise<void>; release: () => void } {
  let release = releaseNothing;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * The app database, pausing after its first transaction (the ask, committed) until `resume`: a
 * scheduling pause before custody is asked. The database and custody themselves are unchanged.
 */
function pausedAfterAsk(): { database: Database; reserved: Promise<void>; resume: () => void } {
  const paused = latch();
  const reserved = latch();
  let first = true;
  const database: Database = {
    ...w.db.app,
    withBusiness: async (business, run) => {
      const result = await w.db.app.withBusiness(business, run);
      if (first) {
        first = false;
        reserved.release();
        await paused.promise;
      }
      return result;
    },
  };
  return { database, reserved: reserved.promise, resume: paused.release };
}

/**
 * One host clock, moved forward by `ms` from now on: as if the sender's host stood still that long
 * (`performance`), or was suspended or stepped by its time service (`Date`), which the other clock
 * does not see.
 */
function moved(clock: 'performance' | 'Date', ms: number): void {
  if (clock === 'performance') {
    const real = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => real() + ms);
  } else {
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() + ms);
  }
}

/** Every delivery attempt one invitation's sends recorded, oldest first. */
async function attemptsFor(
  invitationId: string,
): Promise<readonly { state: string; evidence: string | null }[]> {
  return await w.db.admin.execute<{ state: string; evidence: string | null }>(
    `select state, evidence from public.invitation_delivery_attempts
      where invitation_id = $1 order by observed_seq`,
    [invitationId],
  );
}

/** A send paused after its ask while one host clock moves `ms`, then resumed. */
async function sendPaused(id: string, clock: 'performance' | 'Date', ms: number) {
  const held = pausedAfterAsk();
  const sending = sendInvitation(held.database, w.alpha, id, w.broker, MAIL);
  try {
    await held.reserved;
    moved(clock, ms);
    held.resume();
    return await sending;
  } finally {
    held.resume();
    await sending.catch(() => {});
    vi.restoreAllMocks();
  }
}

async function waitUntil(check: () => Promise<boolean>, milliseconds = 5000): Promise<void> {
  const until = Date.now() + milliseconds;
  // eslint-disable-next-line no-await-in-loop -- each wait observes the preceding database state
  while (!(await check())) {
    if (Date.now() >= until) throw new Error('Timed out waiting for the database schedule');
    // eslint-disable-next-line no-await-in-loop -- each wait observes the preceding database state
    await delay(20);
  }
}

/**
 * Run `run` while another connection holds the business's email limit lock, released only once
 * the invitation has expired and the send is waiting on that lock.
 */
async function expiringOnTheLimitLock<T>(id: string, run: () => Promise<T>): Promise<T> {
  await w.db.admin.execute(
    "update public.invitations set expires_at = clock_timestamp() + interval '1500 milliseconds' where id = $1",
    [id],
  );
  const blocker = connect(w.db.appUrl);
  const held = latch();
  const released = latch();
  let pid = 0;
  const holding = blocker.withBusiness(w.alpha, async (tx) => {
    const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
    pid = row?.pid ?? 0;
    await advisoryLock(tx, `limit:${w.alpha}:email:${EMAIL_SEND.key}`);
    held.release();
    await released.promise;
  });
  try {
    await Promise.race([held.promise, holding]);
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
    released.release();
    return await running;
  } finally {
    released.release();
    await holding.catch(() => {});
    await blocker.close();
  }
}

describe.skipIf(noDatabase)('C39-T an invitation send and the in-flight fence', () => {
  it.each([
    // Short of the grace itself, past the margin the fence keeps before it.
    { clock: 'performance' as const, ms: IN_FLIGHT_GRACE_MS - 5000, why: 'within ms of the grace' },
    // The wall clock alone: a suspended host, which the monotonic clock does not count.
    { clock: 'Date' as const, ms: IN_FLIGHT_GRACE_MS + 10_000, why: 'on the wall clock only' },
  ])('a send paused past the fence $why calls no provider', async ({ clock, ms }) => {
    const id = await invite(c.admin);
    const before = received();
    const result = await sendPaused(id, clock, ms);
    expect(result).toMatchObject({ ok: false, code: 'EMAIL_FAILED', fault: 'expired' });
    expect(received()).toBe(before);
    expect(await attemptsFor(id)).toEqual([
      { state: 'asked', evidence: null },
      { state: 'failed', evidence: 'expired' },
    ]);
  });

  it('a send paused inside the fence still sends', async () => {
    const id = await invite(c.admin);
    const before = received();
    const result = await sendPaused(id, 'performance', IN_FLIGHT_GRACE_MS - 20_000);
    expect(result).toMatchObject({ ok: true, state: 'accepted' });
    expect(received()).toBe(before + 1);
    expect((await attemptsFor(id)).map((row) => row.state)).toStrictEqual(['asked', 'accepted']);
  });

  it('an invitation expiring while its send waits on the email limit lock sends nothing', async () => {
    const id = await invite(c.admin);
    const before = received();
    const result = await expiringOnTheLimitLock(id, async () => await send(id));
    expect(result).toStrictEqual({ ok: false, code: 'INVITATION_NOT_PENDING' });
    expect(received()).toBe(before);
    expect(await countFor('enrolment_tokens', id)).toBe(0);
    expect(await countFor('invitation_delivery_attempts', id)).toBe(0);
  });
});
