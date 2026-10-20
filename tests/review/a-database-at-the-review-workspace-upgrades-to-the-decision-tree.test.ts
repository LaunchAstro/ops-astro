// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X (#2142, carrying #2129 onto #2105): a database migrated at #2105's review workspace,
// whose ledger holds the review records as 20261019123500, upgrades to this tree. An applied
// migration is never renamed, so the review records keep that version here and the decision
// tree adds only what the workspace did not have. Proof rebuilt from Sol's S2208-2.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { createEmptyDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';

/** #2105's review workspace head, the first parent this branch's carry of #2129 merged onto. */
const WORKSPACE = '992b3ff106cc1f034edd6f6e1bbbc3b7cae11cad';
const serverUrl = databaseUrlFromEnvironment();

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' });

/** The workspace's migrations, as files in a directory of their own. */
function workspaceMigrations(): string {
  const directory = mkdtempSync(join(tmpdir(), 'c35x-workspace-migrations-'));
  for (const path of git('ls-tree', '--name-only', `${WORKSPACE}:migrations`).split('\n')) {
    if (path.endsWith('.sql')) {
      writeFileSync(join(directory, path), git('show', `${WORKSPACE}:migrations/${path}`));
    }
  }
  return directory;
}

describe.skipIf(serverUrl === undefined)('C35-X upgrade from the review workspace', () => {
  it('a database migrated at the review workspace upgrades to this tree, its review records kept', async () => {
    const directory = workspaceMigrations();
    const db = await createEmptyDatabase({ part: 'c35x_workspace_upgrade' });
    try {
      await applyMigrations(db.admin, readMigrations(directory));
      const [recorded] = await db.admin.execute<{ readonly version: string }>(
        `select version from ops.schema_migrations where version like '%_review_records'`,
      );
      expect(recorded?.version).toBe('20261019123500_review_records');
      await db.closeSessions();
      await expect(applyMigrations(db.admin, readMigrations('migrations'))).resolves.not.toThrow();
    } finally {
      await db.drop();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
