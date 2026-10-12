// SPDX-License-Identifier: AGPL-3.0-only
//
// When the migration that checks the backup identity's reach stops a staging
// reset, the reset names what the backup identity cannot read, so the
// operator knows which schema or table to fix. A grant that gives nothing is
// stood in for by a table whose read is taken back after every grant.

import { expect, it } from 'vitest';
import {
  onDatabase,
  quiet,
  run,
  serverUrl,
  settings,
  stagingResetHooks,
} from './s0-1-staging-reset.fixture.ts';

stagingResetHooks();

it.skipIf(serverUrl === undefined)(
  'staging reset stopped by the backup reach check names the table the backup identity cannot read',
  async () => {
    await onDatabase(async (admin) => {
      await admin.execute('create schema reach_gap');
      await admin.execute('create table auth.unread_by_backup (x int)');
      await admin.execute(`create function reach_gap.take_back() returns event_trigger
        language plpgsql as $$ begin
          revoke select on auth.unread_by_backup from ops_astro_backup;
        end $$`);
      await admin.execute(`create event trigger reach_gap_take_back on ddl_command_end
        when tag in ('GRANT') execute function reach_gap.take_back()`);
    });

    const result = await run(settings());

    expect(result.status).toBe(1);
    expect(result.out).toContain(
      'stopped while migrating (the backup identity cannot read auth.unread_by_backup)',
    );
    quiet(result);
  },
  360_000,
);
