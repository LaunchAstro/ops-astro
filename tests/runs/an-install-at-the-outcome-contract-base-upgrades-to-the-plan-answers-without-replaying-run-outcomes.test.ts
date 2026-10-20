// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof on #2095 (S2095-1), kept under the name of what it proves: an
// install already at the outcome contract's base (this tree's migrations
// without the plan answers', run_outcomes as main holds it) upgrades to this
// head by applying only the plan answers' migration, never replaying
// run_outcomes.

import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it as vitestIt } from 'vitest';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;

const PLAN_ANSWERS = '20261019135000_run_outcomes_plan_answers';

it('an install at the outcome contract base upgrades to the plan answers without replaying run_outcomes', async () => {
  const stems = readdirSync('migrations')
    .filter((file) => file.endsWith('.sql'))
    .map((file) => file.slice(0, -'.sql'.length))
    .toSorted();
  const outcomes = stems.filter((stem) => /^\d{14}_run_outcomes$/u.test(stem));
  expect(outcomes, 'one run_outcomes migration').toHaveLength(1);
  expect(stems, 'the plan answers come after it').toContain(PLAN_ANSWERS);
  expect(stems.indexOf(PLAN_ANSWERS)).toBeGreaterThan(stems.indexOf(String(outcomes[0])));

  const directory = mkdtempSync(join(tmpdir(), 'sol2095-base-'));
  try {
    for (const stem of stems) {
      if (stem !== PLAN_ANSWERS) {
        copyFileSync(join('migrations', `${stem}.sql`), join(directory, `${stem}.sql`));
      }
    }
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
        `select version from ops.schema_migrations where version = any($1::text[]) order by version`,
        [[String(outcomes[0]), PLAN_ANSWERS]],
      );
      expect(
        ledger,
        'the base kept its run_outcomes row and the upgrade added the plan answers',
      ).toEqual([{ version: String(outcomes[0]) }, { version: PLAN_ANSWERS }]);
    } finally {
      await db.drop();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
