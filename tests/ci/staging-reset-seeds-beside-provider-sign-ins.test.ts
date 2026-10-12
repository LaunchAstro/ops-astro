// SPDX-License-Identifier: AGPL-3.0-only
// Review proof (REVIEW-MAIN-B1 p13-1). On a hosted project the provider keeps
// its sign-ins in `auth.users`, in the same database the reset empties, and the
// reset never empties `auth.users`. Before #298 the seed then judged an
// unmarked database whose sign-in table had held a row and refused it. The
// stand-in now writes `auth.users` as the provider does; this file adds the
// cast's made-up sign-ins there once more and runs the reset again.
// The provider lists its sign-ins a page at a time, and the stand-in pages as
// it does: a cast sign-in past the first page is still found and reset.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { STAGING_CAST } from '../../scripts/ops/staging-reset.ts';
import {
  calls,
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

it.skipIf(serverUrl === undefined)(
  'staging reset finds a made-up sign-in the provider lists past its first page',
  async () => {
    // More invented sign-ins than one page holds, made before the cast's, so
    // the provider lists the cast from its second page on.
    const made = [...users];
    users.clear();
    for (let n = 1; n <= 200; n += 1) users.set(`extra-${String(n)}@alpha.local`, randomUUID());
    for (const [email, id] of made) users.set(email, id);
    const ada = users.get('ada@alpha.local');
    const before = calls.length;

    const result = await run(settings());

    expect(result.status, `the reset finishes\n${result.out}`).toBe(0);
    const asked = calls.slice(before);
    expect(
      asked.some((call) => call.method === 'GET' && /(?:^|&)page=2(?:&|$)/u.test(call.query)),
    ).toBe(true);
    expect(
      asked.some((call) => call.method === 'PUT' && call.path === `/admin/users/${String(ada)}`),
    ).toBe(true);
  },
  360_000,
);
