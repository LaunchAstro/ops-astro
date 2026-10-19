// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof on #2095 (S2095-1), kept under the name of what it proves: an
// install already at the outcome contract's stated base (#1896 at 9c502a0da0,
// whose run_outcomes migration is 20261019083500) upgrades to this head by
// applying only the plan answers' migration, never replaying run_outcomes.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it as vitestIt } from 'vitest';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;

const PLAN_ANSWERS = '20261019090000_run_outcomes_plan_answers.sql';

it('an install at the outcome contract base upgrades to the plan answers without replaying run_outcomes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sol2095-base-'));
  try {
    for (const file of readdirSync('migrations')) {
      if (
        file.endsWith('.sql') &&
        file !== '20261018151500_run_outcomes.sql' &&
        file !== PLAN_ANSWERS
      ) {
        copyFileSync(join('migrations', file), join(directory, file));
      }
    }
    const oldName = '20261019083500_run_outcomes.sql';
    writeFileSync(
      join(directory, oldName),
      execFileSync('git', [
        'show',
        `9c502a0da0867ce17d1c4bc3c6258a77486ca906:migrations/${oldName}`,
      ]),
    );
    const db = await createFreshDatabase({
      part: 'sol2095upgrade',
      migrationsDirectory: directory,
    });
    try {
      await expect(applyMigrations(db.admin, readMigrations(directory))).resolves.toMatchObject({
        applied: [],
      });
      await expect(applyMigrations(db.admin, readMigrations('migrations'))).resolves.toBeDefined();
      const ledger = await db.admin.execute<{ version: string }>(
        `select version from ops.schema_migrations where version in ('20261019083500', '20261019090000')
          order by version`,
      );
      expect(
        ledger,
        'the base kept its run_outcomes row and the upgrade added the plan answers',
      ).toEqual([{ version: '20261019083500' }, { version: '20261019090000' }]);
    } finally {
      await db.drop();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
