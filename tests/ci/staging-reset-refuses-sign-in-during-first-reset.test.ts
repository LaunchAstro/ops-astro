// SPDX-License-Identifier: AGPL-3.0-only
// A new database has no guard on `auth.users` until the reset puts one there,
// after its own check. A sign-in that is not a made-up address, made in that
// time, stops the reset before anything is marked or seeded, and the next run
// refuses the database.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  beforeNextCall,
  onDatabase,
  quiet,
  run,
  serverUrl,
  settings,
  stagingResetHooks,
} from './s0-1-staging-reset.fixture.ts';

stagingResetHooks();

it.skipIf(serverUrl === undefined)(
  'staging reset stops when a real sign-in lands on a new database during its first run',
  async () => {
    beforeNextCall.work = async () =>
      await onDatabase((admin) =>
        admin.execute('insert into auth.users (id, email) values ($1, $2)', [
          randomUUID(),
          'owner.canary@example.net',
        ]),
      );
    const first = await run(settings());
    expect(first.status, first.out).toBe(1);
    expect(first.out).toContain('stopped while emptying');
    expect(first.out).not.toContain('owner.canary');
    quiet(first);
    const marked = await onDatabase((admin) =>
      admin.execute<{ mark: string | null }>(
        `select shobj_description(oid, 'pg_database') as mark
           from pg_database where datname = current_database()`,
      ),
    );
    expect(marked[0]?.mark ?? null, 'a stopped first run leaves no mark').toBeNull();

    const again = await run(settings());
    expect(again.status, again.out).toBe(1);
    expect(again.out).toContain('neither marked made-up nor new');
    quiet(again);
  },
  360_000,
);
