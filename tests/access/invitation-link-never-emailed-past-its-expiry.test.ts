// SPDX-License-Identifier: AGPL-3.0-only
//
// An invitation's link and its lifetime. A send whose ask committed while the
// invitation was live, then stalled (a slow commit, a paused host) until the
// invitation's expiry had passed on either host clock, emails nothing: it
// calls no provider and records `failed`, evidence `expired`, well inside the
// in-flight fence.

import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendInvitation } from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { latch } from '../support/lock-wait-race.ts';
import { c, invite, MAIL, noDatabase, received, useInvitationWorld, w } from './c39-t-world.ts';

useInvitationWorld();

afterEach(() => {
  vi.restoreAllMocks();
});

/** How long the invitation has left when its send asks. */
const LIFE_MS = 2000;

/** The app database, pausing after its first transaction (the ask, committed) until `resume`. */
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
        reserved.open();
        await paused.promise;
      }
      return result;
    },
  };
  return { database, reserved: reserved.promise, resume: () => paused.open() };
}

/** One host clock, moved forward by `ms` from now on, which the other clock does not see. */
function moved(clock: 'performance' | 'Date', ms: number): void {
  if (clock === 'performance') {
    const real = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => real() + ms);
  } else {
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() + ms);
  }
}

/** Until the database's own clock reads past the invitation's expiry. */
async function expired(invitationId: string): Promise<void> {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each read observes the clock again
    const [row] = await w.db.admin.execute<{ past: boolean }>(
      'select clock_timestamp() > expires_at as past from public.invitations where id = $1',
      [invitationId],
    );
    if (row?.past === true) return;
    // oxlint-disable-next-line no-await-in-loop -- each read observes the clock again
    await delay(50);
  }
}

describe.skipIf(noDatabase)('an invitation link and its lifetime', () => {
  it.each([
    { stall: 'the monotonic clock passes', pass: (_id: string) => moved('performance', 5000) },
    { stall: 'the wall clock alone passes', pass: (_id: string) => moved('Date', 5000) },
    { stall: 'the real time passes', pass: async (id: string) => await expired(id) },
  ])('a send stalled after its ask while $stall the expiry emails no link', async ({ pass }) => {
    const id = await invite(c.admin);
    await w.db.admin.execute(
      `update public.invitations
            set expires_at = clock_timestamp() + make_interval(secs => $2::double precision / 1000)
          where id = $1`,
      [id, LIFE_MS],
    );
    const before = received();
    const held = pausedAfterAsk();
    const sending = sendInvitation(held.database, w.alpha, id, w.broker, MAIL);
    await held.reserved;
    await pass(id);
    held.resume();
    const result = await sending;
    expect(result).toMatchObject({ ok: false, code: 'EMAIL_FAILED', fault: 'expired' });
    expect(received()).toBe(before);
    const attempts = await w.db.admin.execute<{ state: string; evidence: string | null }>(
      `select state, evidence from public.invitation_delivery_attempts
          where invitation_id = $1 order by observed_seq`,
      [id],
    );
    expect(attempts).toEqual([
      { state: 'asked', evidence: null },
      { state: 'failed', evidence: 'expired' },
    ]);
  });
});
