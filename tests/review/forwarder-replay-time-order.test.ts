// SPDX-License-Identifier: AGPL-3.0-only
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createForwarder } from '../../apps/forwarder/forward.ts';
import { createFreshDatabase } from '../support/fresh-database.ts';

it('timestamps out of identity order across replay batches cannot fabricate a sign-in burst', async () => {
  const db = await createFreshDatabase({ part: 'solow007_order' });
  try {
    const scope = 'ab'.repeat(32);
    // A later identity can carry an older transaction timestamp. Keep both groups
    // inside retention, but separated by more than the sign-in rule's 15 minutes.
    await db.admin.execute(
      `insert into ops.api_events (kind, scope, at)
       select 'sign-in-failed', $1, now() - interval '1 minute' from generate_series(1, 4)`,
      [scope],
    );
    // Distinct scopes fill the first 500-row batch without reaching a threshold.
    await db.admin.execute(
      `insert into ops.api_events (kind, scope, at)
       select 'sign-in-failed', lpad(to_hex(n), 64, '0'), now() - interval '1 minute'
         from generate_series(1, 496) n`,
    );
    await db.admin.execute(
      "insert into ops.api_events (kind, scope, at) values ('sign-in-failed', $1, now() - interval '20 minutes')",
      [scope],
    );
    const events: string[] = [];
    await createForwarder({
      database: db.admin,
      where: 'staging',
      root: resolve('.'),
      send: (event) => {
        if (event.level === 'warning') events.push(event.tags['alert'] ?? '');
        return Promise.resolve();
      },
    }).once();
    expect(
      events,
      'four recent failures and one 19 minutes earlier are never five inside 15 minutes',
    ).toEqual([]);
  } finally {
    await db.drop();
  }
});
