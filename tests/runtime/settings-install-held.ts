// SPDX-License-Identifier: AGPL-3.0-only
//
// A command run while a first settings install holds the business's settings
// install lock: the command is seen waiting on that lock on the server, a
// person's grants end while it waits, and only then does the install commit.
// A command that read its clock before the wait would still judge the grants
// live.

import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { awaitParked, barrier, racer, waitPast, type Schedules } from './schedules-harness.ts';

/** The business back to no settings rows, the state before its first install. */
export async function withoutSettings(s: Schedules): Promise<void> {
  await s.db.admin.execute('delete from public.business_settings where business_id = $1', [
    s.business,
  ]);
}

/** Every grant `personId` holds ends three seconds from now; the answer puts their ends back. */
export async function grantsEndSoon(s: Schedules, personId: string): Promise<() => Promise<void>> {
  const ends = await s.db.admin.execute<{ id: string; expires_at: string | null }>(
    `select id, expires_at::text from public.grants
      where business_id = $1 and subject_kind = 'person' and subject_id = $2`,
    [s.business, personId],
  );
  await s.db.admin.execute(
    `update public.grants set expires_at = clock_timestamp() + interval '3 seconds'
      where business_id = $1 and subject_kind = 'person' and subject_id = $2`,
    [s.business, personId],
  );
  return async () => {
    for (const end of ends) {
      // eslint-disable-next-line no-await-in-loop -- one grant row at a time
      await s.db.admin.execute(
        'update public.grants set expires_at = $2::timestamptz where id = $1',
        [end.id, end.expires_at],
      );
    }
  };
}

/** `command`, run on its own connection, held behind a first install until `personId`'s grants have ended. */
export async function pastGrantsBehindInstall<T>(
  s: Schedules,
  personId: string,
  command: () => Promise<T>,
): Promise<T> {
  const installer = racer(s);
  const installed = barrier();
  const finish = barrier();
  const installing = installer.withBusiness(s.business, async (tx) => {
    await installBusinessSettings(tx);
    installed.release();
    await finish.held;
  });
  await installed.held;
  const running = command();
  try {
    await awaitParked(s, 'advisory', 1);
    await waitPast(s, 'select max(expires_at) from public.grants where subject_id = $1', personId);
    finish.release();
    await installing;
    return await running;
  } finally {
    finish.release();
    await Promise.allSettled([installing, running]);
    await installer.close();
  }
}
