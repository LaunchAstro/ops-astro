// SPDX-License-Identifier: AGPL-3.0-only
// A named database suite must reach the database even when it runs alone.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createEmptyDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

it.skipIf(serverUrl === undefined)(
  'the named service-stop suite reaches its own database',
  async () => {
    const db = await createEmptyDatabase({ part: 'stopproof' });
    const directory = mkdtempSync(join(tmpdir(), 'named-service-stop-'));
    try {
      const manifest = join(directory, 'named-suites.json');
      writeFileSync(
        manifest,
        JSON.stringify({ invariant: ['tests/ci/service-stop.test.ts'], conformance: [] }),
      );
      if (serverUrl === undefined) throw new Error('database URL is required for this proof');
      const url = new URL(serverUrl);
      url.pathname = `/${db.name}`;
      // Let the new database's creation counters settle before measuring this suite.
      await setTimeout(1500);
      const run = spawnSync(process.execPath, ['scripts/db-conformance.mjs', '--manifest', manifest], {
        cwd: join(import.meta.dirname, '../..'),
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: url.toString() },
      });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await db.drop();
    }
  },
);
