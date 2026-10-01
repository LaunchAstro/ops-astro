// SPDX-License-Identifier: AGPL-3.0-only
// Review proof (REVIEW-MAIN-B1 p13-1). On a hosted project the provider keeps
// its sign-ins in `auth.users`, in the same database the reset empties. The
// reset makes the cast's sign-ins there before it seeds, and never empties
// `auth.users`, so the seed it starts (LOCAL_SEED_MADE_UP=confirm, mark just
// cleared) judges an unmarked database whose sign-in table has held a row and
// refuses it. The loopback stand-in here writes no `auth.users`, so this file
// puts the cast's made-up sign-ins there, as the provider holds them after a
// reset, and runs the reset again.

import { expect, it } from 'vitest';
import { STAGING_CAST } from '../../scripts/ops/staging-reset.ts';
import {
  onDatabase,
  run,
  serverUrl,
  settings,
  stagingResetHooks,
  users,
} from './s0-1-staging-reset.fixture.ts';

stagingResetHooks();

it.skipIf(serverUrl === undefined)(
  'staging reset seeds a staging database whose auth.users holds its own made-up sign-ins',
  async () => {
    const first = await run(settings());
    expect(first.status, `precondition: the first reset finishes\n${first.out}`).toBe(0);

    // What the provider holds once the reset has made the cast's sign-ins.
    await onDatabase(async (admin) => {
      await admin.execute('create schema if not exists auth');
      await admin.execute('create table if not exists auth.users (id uuid, email text)');
      for (const member of STAGING_CAST)
        // oxlint-disable-next-line no-await-in-loop -- one row at a time
        await admin.execute('insert into auth.users (id, email) values ($1, $2)', [
          users.get(member.email),
          member.email,
        ]);
    });

    const again = await run(settings());
    expect(
      again.status,
      'staging reset defect: the seed refuses the database the reset just emptied, because ' +
        'auth.users holds the made-up sign-ins the reset itself made (unmarked + not new)\n' +
        again.out,
    ).toBe(0);
  },
  360_000,
);
