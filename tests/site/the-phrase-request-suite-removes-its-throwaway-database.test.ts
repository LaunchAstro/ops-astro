// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof on #2094 (S2094-2), assertions unchanged: the phrase request
// suite, run on its own, leaves no throwaway database behind. The child is
// given its own name part, so only the database it made is watched and, if
// left, removed with its two login roles; another suite's is never touched.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const url = databaseUrlFromEnvironment();
if (url === undefined) console.warn('Phrase suite cleanup: DATABASE_URL is unset, so nothing ran.');

it.skipIf(url === undefined)(
  'the phrase request suite removes its throwaway database',
  async () => {
    if (url === undefined) throw new Error('This proof requires a database');
    const admin = connectAsAdmin(url);
    // The child's own name part, so only the database it made is watched (S2094-4).
    const part = `phrase${randomBytes(4).toString('hex')}`;
    const databases = async () =>
      (
        await admin.execute<{ datname: string }>(
          'select datname from pg_database where starts_with(datname, $1)',
          [`t1_${part}_`],
        )
      ).map(({ datname }) => datname);
    const before = new Set(await databases());
    let leaked: string[] = [];
    try {
      execFileSync(
        './node_modules/.bin/vitest',
        ['run', 'tests/site/a-phrase-request-is-stored-by-the-door-and-the-agent.test.ts'],
        { stdio: 'pipe', timeout: 120_000, env: { ...process.env, PHRASE_SUITE_PART: part } },
      );
      leaked = (await databases()).filter((name) => !before.has(name));
      expect(leaked).toEqual([]);
    } finally {
      // Only databases created by this proof's child, never another run's database.
      const own = new RegExp(`^t1_${part}_[0-9a-f]{12}$`, 'u');
      for (const name of leaked.filter((each) => own.test(each))) {
        // oxlint-disable-next-line no-await-in-loop -- one database and its roles at a time
        await admin.execute(`drop database "${name}" with (force)`);
        // oxlint-disable-next-line no-await-in-loop -- as above
        await admin.execute(`drop role "${name}_app"`);
        // oxlint-disable-next-line no-await-in-loop -- as above
        await admin.execute(`drop role "${name}_out"`);
      }
      await admin.close();
    }
  },
  130_000,
);
