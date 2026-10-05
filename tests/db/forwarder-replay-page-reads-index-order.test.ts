// SPDX-License-Identifier: AGPL-3.0-only
//
// The forwarder replays `ops.api_events` in `(at, id)` order, page by page.
// Without an index in that order every page sorts the whole table, so a flood
// of sign-in failures makes a pass quadratic and holds back every alert. The
// replay's own page query, planned with sorting priced out, must read the
// index and sort nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPLAY_PAGE } from '../../apps/forwarder/forward.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

let db: FreshDatabase;

describe.skipIf(databaseUrlFromEnvironment() === undefined)('the forwarder replay page', () => {
  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'replay_page_index' });
    await db.admin.execute(
      `insert into ops.api_events (kind, scope, at)
       select 'sign-in-failed', lpad(to_hex(n), 64, '0'), now() - make_interval(secs => n)
         from generate_series(1, 5000) n`,
    );
    await db.admin.execute('analyze ops.api_events');
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('reads each page in index order, sorting nothing', async () => {
    const plan = await db.admin.transaction(async (execute) => {
      await execute('set local enable_sort = off');
      return await execute<{ 'QUERY PLAN': unknown }>(`explain (format json) ${REPLAY_PAGE}`, [
        '-infinity',
        '0',
        500,
      ]);
    });
    const text = JSON.stringify(plan);
    expect(text).toContain('api_events_at_id_idx');
    expect(text).not.toContain('"Node Type":"Sort"');
  });
});
