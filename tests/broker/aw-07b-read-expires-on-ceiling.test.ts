// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b, a client read that expires while a send waits on the ceiling's lock.
// The recipient's read is judged again after that wait, at the moment it is
// judged, not when the send's transaction began: a grant that lapsed during
// the wait withholds the item, writes nothing and sends nothing.

import { expect, it as vitestIt } from 'vitest';
import { emailAtOnce } from '../../packages/core-custody/src/index.ts';
import { roomFor } from '../../packages/core-custody/src/email-class.ts';
import { EMAIL_SEND } from '../../packages/core-connectors/src/index.ts';
import { connect, taskAccess } from '../../packages/core-records/src/index.ts';
import { attemptsOf, itemFor, noDatabase, useEmailWorld, w } from './email-world.ts';
import { freshInbox, heldOpen, timing, useTimingWorld } from './email-timing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;
useEmailWorld();
useTimingWorld();

/** The recipient's one client read grant, set to lapse three seconds from now. */
async function lapsingRead(): Promise<string> {
  const [grant] = await w.db.admin.execute<{ id: string }>(
    `update public.grants set expires_at = clock_timestamp() + interval '3 seconds'
      where business_id = $1 and subject_kind = 'person' and subject_id = $2
        and collection = 'task' and action = 'read' and revoked_at is null returning id`,
    [w.alpha, w.person],
  );
  if (grant === undefined) throw new Error('missing client read grant');
  return grant.id;
}

/** Until the send waits on the ceiling's lock and the grant has lapsed meanwhile. */
async function waitingPastExpiry(grant: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const [row] = await w.db.admin.execute<{ waiting: number }>(
          `select count(*)::int as waiting from pg_locks
        where locktype = 'advisory' and not granted
          and database = (select oid from pg_database where datname = current_database())`,
        );
        return row?.waiting;
      },
      { timeout: 5000 },
    )
    .toBe(1);
  await expect
    .poll(
      async () => {
        const [row] = await w.db.admin.execute<{ expired: boolean }>(
          'select expires_at <= clock_timestamp() as expired from public.grants where id = $1',
          [grant],
        );
        return row?.expired;
      },
      { timeout: 5000 },
    )
    .toBe(true);
}

it('AW-07b a client read expiring during the ceiling wait withholds the email', async () => {
  await freshInbox();
  const item = await itemFor(w.task, 'decision');
  const before = w.provider.outbox.length;
  const operation = w.broker.operations.get(EMAIL_SEND.key);
  if (operation === undefined) throw new Error('missing email operation');
  const grant = await lapsingRead();
  const holder = await heldOpen(async (tx) => {
    expect(await roomFor(tx, operation)()).toBe(true);
  });
  const reader = connect(w.db.appUrl);
  const sending = emailAtOnce(w.db.app, w.alpha, item, timing());
  const settled = sending.catch(() => {});
  let released = false;
  try {
    await waitingPastExpiry(grant);
    // A new read sees the expiry before the waiting sender resumes its post-lock check.
    expect(
      await reader.withBusiness(w.alpha, async (tx) => await taskAccess(tx, w.person, w.task)),
    ).toBe('withheld');
    await holder.release();
    released = true;
    const result = await sending;
    const attempts = await attemptsOf(item);
    expect({
      result,
      states: attempts.map((row) => row.state),
      emails: w.provider.outbox.length - before,
    }).toEqual({ result: { ok: false, code: 'ITEM_WITHHELD' }, states: [], emails: 0 });
  } finally {
    if (!released) await holder.release();
    await settled;
    await reader.close();
    await w.db.admin.execute('update public.grants set expires_at = null where id = $1', [grant]);
  }
});
