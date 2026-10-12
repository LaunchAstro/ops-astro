// SPDX-License-Identifier: AGPL-3.0-only
//
// An invitation's send asks under the invitation's row lock (the act's one
// send, the email limit, the minted token and its life read after every wait),
// then sends, then records what came back. Each racer here is a connection of
// its own, seen waiting on a holder of the invitation row before it is let go;
// a lost reply is a relay cut at a named point of the ask's commit.

import { setTimeout as delay } from 'node:timers/promises';
import { expect, it as vitestIt } from 'vitest';
import { sendInvitation } from '../../packages/core-custody/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { hold, latch, waiterOf, waitPast } from '../support/lock-wait-race.ts';
import { cutProxy, settle, type CutPoint } from '../runtime/schedules-harness.ts';
import {
  as,
  c,
  codeOf,
  invite,
  MAIL,
  noDatabase,
  received,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

useInvitationWorld();

const it = noDatabase ? vitestIt.skip : vitestIt;

const racer = (url: string = w.db.appUrl): Database => connect(url, { source: 'racer' });

const holdInvitation = async (id: string) =>
  await hold(w.db, async (execute) => {
    await execute('select id from public.invitations where id = $1 for update', [id]);
  });

const sentFor = async (id: string) => ({
  tokens: Number(
    (
      await w.db.admin.execute<{ n: string }>(
        'select count(*)::text as n from public.enrolment_tokens where invitation_id = $1',
        [id],
      )
    )[0]?.n,
  ),
  attempts: (
    await w.db.admin.execute<{ state: string }>(
      `select state from public.invitation_delivery_attempts
        where invitation_id = $1 order by observed_seq`,
      [id],
    )
  ).map((row) => row.state),
});

/** `base`, pausing after its first transaction (the ask, committed) until `resume`. */
function pausedAfterAsk(base: Database) {
  const paused = latch();
  const reserved = latch();
  let first = true;
  const database: Database = {
    ...base,
    withBusiness: async (business, run) => {
      const result = await base.withBusiness(business, run);
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

it('two sends for one act at once email one link: the second finds the act sent', async () => {
  const id = await invite(c.admin);
  const before = received();
  const holder = await holdInvitation(id);
  const first = racer();
  const second = racer();
  try {
    const a = sendInvitation(first, w.alpha, id, w.broker, MAIL);
    await waiterOf(w.db, holder);
    const b = sendInvitation(second, w.alpha, id, w.broker, MAIL);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
      const waiting = await w.db.admin.execute<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity a
          where a.datname = current_database() and a.wait_event_type = 'Lock'
            and $1::int = any(pg_blocking_pids(a.pid))`,
        [holder.pid],
      );
      if ((waiting[0]?.n ?? 0) >= 2) break;
      // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
      await delay(25);
    }
    await holder.letGo();
    const results = await settle([a, b]);
    const outcomes = results.map((result) =>
      result.status === 'fulfilled' ? (result.value.ok ? 'accepted' : result.value.code) : 'threw',
    );
    expect(outcomes).toEqual(['accepted', 'NO_SEND_ACT']);
  } finally {
    await holder.letGo();
    await first.close();
    await second.close();
  }
  expect(received() - before).toBe(1);
  expect(await sentFor(id)).toEqual({ tokens: 1, attempts: ['asked', 'accepted'] });
});

it('a send that waited on the invitation row while its life ran down, then stalled past the expiry, emails nothing', async () => {
  const id = await invite(c.admin);
  await w.db.admin.execute(
    `update public.invitations set expires_at = clock_timestamp() + interval '3 seconds'
      where id = $1`,
    [id],
  );
  const [row] = await w.db.admin.execute<{ expiry: string; nearly: string }>(
    `select expires_at::text as expiry, (expires_at - interval '1 second')::text as nearly
       from public.invitations where id = $1`,
    [id],
  );
  if (row === undefined) throw new Error('no invitation');
  const before = received();
  const holder = await holdInvitation(id);
  const sender = racer();
  const paused = pausedAfterAsk(sender);
  try {
    const sending = sendInvitation(paused.database, w.alpha, id, w.broker, MAIL);
    await waiterOf(w.db, holder);
    await waitPast(w.db, row.nearly);
    await holder.letGo();
    await paused.reserved;
    await waitPast(w.db, row.expiry);
    paused.resume();
    expect(await sending).toMatchObject({ ok: false, code: 'EMAIL_FAILED', fault: 'expired' });
  } finally {
    await holder.letGo();
    paused.resume();
    await sender.close();
  }
  expect(received() - before).toBe(0);
  expect(await sentFor(id)).toEqual({ tokens: 1, attempts: ['asked', 'failed'] });
});

it.each<CutPoint>(['before-commit', 'after-commit'])(
  'a send whose ask is cut %s and sent again never emails twice, and a resend emails once',
  async (point) => {
    const id = await invite(c.admin);
    const before = received();
    const proxy = await cutProxy(w.db.appUrl, point);
    const cut = racer(proxy.url);
    try {
      const [interrupted] = await settle([sendInvitation(cut, w.alpha, id, w.broker, MAIL)]);
      expect(proxy.cut(), `the relay never reached its ${point} point`).toBe(true);
      expect(interrupted?.status).toBe('rejected');
    } finally {
      // A client whose socket the relay killed may never finish ending: give it a second.
      await Promise.race([cut.close().catch(() => null), delay(1_000)]);
      await proxy.close();
    }
    expect(received() - before).toBe(0);
    expect(await sentFor(id)).toEqual(
      point === 'after-commit' ? { tokens: 1, attempts: ['asked'] } : { tokens: 0, attempts: [] },
    );
    const again = await sendInvitation(w.db.app, w.alpha, id, w.broker, MAIL);
    if (point === 'before-commit') {
      expect(again).toMatchObject({ ok: true, state: 'accepted' });
      expect(received() - before).toBe(1);
      return;
    }
    // The cut ask may have sent: the act's one send is spent, and a person's resend is the retry.
    expect(again).toMatchObject({ ok: false, code: 'NO_SEND_ACT' });
    expect(received() - before).toBe(0);
    expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId: id }))).toBe('applied');
    expect(await sendInvitation(w.db.app, w.alpha, id, w.broker, MAIL)).toMatchObject({
      ok: true,
      state: 'accepted',
    });
    expect(received() - before).toBe(1);
  },
);
