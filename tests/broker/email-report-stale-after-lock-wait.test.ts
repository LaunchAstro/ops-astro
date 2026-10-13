// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop -- each wait observes the preceding database state */
//
// A send's sender report is judged after the send's last lock wait, not only
// before it: a report that was verified when the send began but aged past
// its freshness while the send waited for an inbox item's or an invitation's
// lock writes no token and no `asked`, and the provider hears nothing. The
// same send with a report checked just now sends once.

import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { SENDER_FRESH_MS } from '../../packages/core-connectors/src/index.ts';
import { sendInboxEmail, sendInvitation } from '../../packages/core-custody/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { attemptsOf, itemFor } from './email-world.ts';
import { c, invite, MAIL, noDatabase, useInvitationWorld, w } from '../access/c39-t-world.ts';

useInvitationWorld();

/** A report that stops being fresh 1.5 seconds from now. */
const agingReport = () => ({
  ...MAIL,
  sender: { ...MAIL.sender, checkedAt: performance.now() - SENDER_FRESH_MS + 1_500 },
});
const freshReport = () => ({ ...MAIL, sender: { ...MAIL.sender, checkedAt: performance.now() } });

const nothing = (): void => {};

/** Hold `lock` in another transaction while `run` starts and waits on it, for two seconds. */
async function behindLock<T>(lock: string, id: string, run: () => Promise<T>): Promise<T> {
  const blocker = connect(w.db.appUrl);
  let pid = 0;
  let release = nothing;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = nothing;
  const holdingNow = new Promise<void>((resolve) => {
    held = resolve;
  });
  const holding = blocker.withBusiness(w.alpha, async (tx) => {
    const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
    pid = row?.pid ?? 0;
    await tx.query(lock, [id]);
    held();
    await released;
  });
  try {
    await holdingNow;
    const running = run();
    const until = Date.now() + 5_000;
    for (;;) {
      const [row] = await w.db.admin.execute<{ n: number }>(
        'select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
        [pid],
      );
      if (row?.n === 1) break;
      if (Date.now() >= until) throw new Error('the send never waited on the lock');
      await delay(20);
    }
    await delay(2_000);
    release();
    return await running;
  } finally {
    release();
    await holding;
    await blocker.close();
  }
}

const tokensOf = async (id: string): Promise<number> =>
  (
    await w.db.admin.execute<{ n: number }>(
      'select count(*)::int as n from public.enrolment_tokens where invitation_id = $1',
      [id],
    )
  )[0]?.n ?? -1;

describe.skipIf(noDatabase)('a sender report judged after the send’s lock waits', () => {
  it('an inbox send whose report ages past freshness while it waits on the item writes nothing and sends nothing', async () => {
    const item = await itemFor(w.task);
    const before = w.provider.received.length;
    const result = await behindLock(
      'select id from public.inbox_items where id = $1 for update',
      item,
      async () => await sendInboxEmail(w.db.app, w.alpha, item, w.broker, agingReport()),
    );
    expect(result).toStrictEqual({ ok: false, code: 'SENDER_NOT_VERIFIED' });
    expect(await attemptsOf(item)).toEqual([]);
    expect(w.provider.received.length).toBe(before);
    const sent = await sendInboxEmail(w.db.app, w.alpha, item, w.broker, freshReport());
    expect(sent).toMatchObject({ ok: true, state: 'accepted' });
    expect(w.provider.received.length).toBe(before + 1);
  });

  it('an invitation send whose report ages past freshness while it waits on the invitation writes no token and sends nothing', async () => {
    const id = await invite(c.admin);
    const before = w.provider.received.length;
    const result = await behindLock(
      'select id from public.invitations where id = $1 for update',
      id,
      async () => await sendInvitation(w.db.app, w.alpha, id, w.broker, agingReport()),
    );
    expect(result).toStrictEqual({ ok: false, code: 'SENDER_NOT_VERIFIED' });
    expect(await tokensOf(id)).toBe(0);
    expect(w.provider.received.length).toBe(before);
    const sent = await sendInvitation(w.db.app, w.alpha, id, w.broker, freshReport());
    expect(sent).toMatchObject({ ok: true, state: 'accepted' });
    expect(await tokensOf(id)).toBe(1);
    expect(w.provider.received.length).toBe(before + 1);
  });
});
