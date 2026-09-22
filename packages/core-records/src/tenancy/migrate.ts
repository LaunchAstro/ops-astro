// SPDX-License-Identifier: AGPL-3.0-only
//
// The migration runner. Numbered SQL files are the only schema truth, so this
// is the only thing in the tree that changes a schema.
//
// Three properties it holds, each because its absence has a known failure.
//
// - A file and its ledger row commit together, so a half-applied migration
//   cannot be recorded as applied. PostgreSQL runs DDL inside transactions,
//   which is what makes this possible at all.
// - An applied migration's checksum is checked on every run. Editing a file
//   that has already been applied is refused rather than ignored, because the
//   database and the file would otherwise disagree in silence.
// - Statements are split and sent one at a time, so the statement log and any
//   error name the statement rather than the file.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdminConnection } from './database.ts';
import { splitStatements } from './statements.ts';

export interface Migration {
  readonly version: string;
  readonly checksum: string;
  readonly statements: readonly string[];
}

export interface MigrationOutcome {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export function readMigrations(directory: string): readonly Migration[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .toSorted()
    .map((name) => {
      const bytes = readFileSync(join(directory, name));
      return {
        version: name.slice(0, -'.sql'.length),
        checksum: createHash('sha256').update(bytes).digest('hex'),
        statements: splitStatements(bytes.toString('utf8')),
      };
    });
}

interface LedgerRow {
  readonly version: string;
  readonly checksum: string;
}

async function readLedger(
  admin: AdminConnection,
): Promise<ReadonlyMap<string, string> | undefined> {
  const [present] = await admin.execute<{ readonly ledger: string | null }>(
    `select to_regclass('ops.schema_migrations')::text as ledger`,
  );
  if (present === undefined || present.ledger === null) return undefined;
  const rows = await admin.execute<LedgerRow>(
    `select version, checksum from ops.schema_migrations`,
  );
  return new Map(rows.map((row) => [row.version, row.checksum]));
}

export async function migrate(
  admin: AdminConnection,
  directory: string,
): Promise<MigrationOutcome> {
  const migrations = readMigrations(directory);
  const ledger = await readLedger(admin);
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const migration of migrations) {
    const recorded = ledger?.get(migration.version);
    if (recorded !== undefined) {
      if (recorded !== migration.checksum) {
        throw new Error(
          `migrate: ${migration.version} was applied as ${recorded} but the file now hashes to ` +
            `${migration.checksum}. An applied migration is history; write a new one.`,
        );
      }
      alreadyApplied.push(migration.version);
      continue;
    }
    // Migrations are ordered and each one may depend on the last, so they are
    // applied one at a time on purpose. The same goes for the statements
    // inside one migration. `Promise.all` here would apply a schema in an
    // order nobody wrote.
    // oxlint-disable-next-line no-await-in-loop
    await admin.transaction(async (execute) => {
      for (const statement of migration.statements) {
        try {
          // oxlint-disable-next-line no-await-in-loop
          await execute(statement);
        } catch (cause) {
          throw new Error(`migrate: ${migration.version} failed on: ${statement.slice(0, 200)}`, {
            cause,
          });
        }
      }
      await execute(`insert into ops.schema_migrations (version, checksum) values ($1, $2)`, [
        migration.version,
        migration.checksum,
      ]);
    });
    applied.push(migration.version);
  }

  return { applied, alreadyApplied };
}
