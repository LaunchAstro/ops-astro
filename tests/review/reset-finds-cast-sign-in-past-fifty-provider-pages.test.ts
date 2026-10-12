// SPDX-License-Identifier: AGPL-3.0-only
// Kept as its reviewer wrote it; only the file name and the title follow
// tests/docs/test-files-by-behaviour.test.ts.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  calls,
  onDatabase,
  run,
  serverUrl,
  settings,
  stagingResetHooks,
  users,
} from '../ci/s0-1-staging-reset.fixture.ts';

stagingResetHooks();

it.skipIf(serverUrl === undefined)(
  'reset finds an existing cast sign-in after fifty complete provider pages',
  async () => {
    const first = await run(settings());
    expect(first.status, first.out).toBe(0);
    const cast = [...users];
    users.clear();
    for (let n = 0; n < 10_000; n += 1) users.set(`extra-${String(n)}@alpha.local`, randomUUID());
    await onDatabase(async (admin) => {
      await admin.execute(
        'insert into auth.users (email, id) select * from unnest($1::text[], $2::uuid[])',
        [[...users.keys()], [...users.values()]],
      );
    });
    for (const [email, id] of cast) users.set(email, id);
    const before = calls.length;
    const result = await run(settings());
    expect(result.status, result.out).toBe(0);
    expect(
      calls
        .slice(before)
        .some((call) => call.method === 'GET' && /(?:^|&)page=51(?:&|$)/u.test(call.query)),
    ).toBe(true);
  },
  360_000,
);
