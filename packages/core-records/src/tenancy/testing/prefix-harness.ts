// SPDX-License-Identifier: AGPL-3.0-only
//
// M01 and M02: every migration prefix, proved where it stands.
//
// A conformance set run against the end state answers a question nobody asked.
// An installation is really in the state after `0001`, and then the state
// after `0002`, and a deploy that stops between two migrations leaves it in
// one of them for as long as it takes somebody to notice. So a prefix that
// opens something a later migration closes again is a failure here, and it
// stays a failure however clean the end state is.
//
// The harness derives its prefixes from the migrations themselves. A lane
// adding `0008` writes `migrations/0008_*.sql` and nothing else: no list to
// extend here, in the assertions, or in a manifest. That is deliberate --
// a prefix proof whose coverage has to be maintained by hand is a proof that
// silently stops covering the newest migration, which is the one nobody has
// read yet.

import { defaultDenyConformance, storageSchemas, type StorageRoles } from '../privileges.ts';
import { tenancyConformance, type Finding } from '../conformance.ts';
import { applyMigrations, type Migration } from '../migrate.ts';
import { splitStatements } from '../statements.ts';
import { APPLICATION_ROLE, type EmptyDatabase } from './fresh-database.ts';
import { createHash } from 'node:crypto';

export interface PrefixProof {
  /** The last migration in this prefix. */
  readonly version: string;
  /** Everything applied to get here, in order. */
  readonly through: readonly string[];
  /** Application tables that exist at this prefix. Zero would mean nothing was checked. */
  readonly tables: number;
  /** The installation's own schemas at this prefix, so storage is answered rather than assumed. */
  readonly schemas: readonly string[];
  /** Tenancy, composite-key and default-deny findings together. Empty is the only pass. */
  readonly findings: readonly Finding[];
}

/** The three roles each prefix is proved against, read from the database itself. */
async function rolesOf(database: EmptyDatabase): Promise<StorageRoles> {
  const rows = await database.admin.execute<{ readonly owner: string }>(
    `select current_user as owner`,
  );
  return {
    owner: rows[0]?.owner ?? 'postgres',
    application: APPLICATION_ROLE,
    restricted: database.restrictedRole,
  };
}

/**
 * Apply the migrations one at a time, and after each one run the whole set:
 * the tenancy catalogue, the composite-key linter, and default deny with the
 * owner, application and restricted roles separated.
 */
export async function proveEachPrefix(
  database: EmptyDatabase,
  migrations: readonly Migration[],
): Promise<readonly PrefixProof[]> {
  const roles = await rolesOf(database);
  const proofs: PrefixProof[] = [];
  const through: string[] = [];

  for (const migration of migrations) {
    // Prefixes are ordered and each one is the state the one before it left.
    // Applying them together, or in parallel, would be a different proof.
    // oxlint-disable-next-line no-await-in-loop
    await applyMigrations(database.admin, [migration]);
    through.push(migration.version);
    const read = database.admin.execute;
    // oxlint-disable-next-line no-await-in-loop
    const [tenancy, deny, schemas, tables] = await Promise.all([
      tenancyConformance(read),
      defaultDenyConformance(read, roles),
      storageSchemas(read),
      read<{ readonly n: string }>(
        `select count(*)::text as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'`,
      ),
    ]);
    proofs.push({
      version: migration.version,
      through: [...through],
      tables: Number(tables[0]?.n ?? 0),
      schemas,
      findings: [...tenancy, ...deny],
    });
  }

  return proofs;
}

/**
 * A migration that is not on disk, for proving the harness can fail.
 *
 * A permissive intermediate prefix has to be made rather than found: no file
 * in the tree is one, which is exactly the property under test. This builds it
 * with a real checksum and real split statements, so the runner applies and
 * records it the way it does any other.
 */
export function syntheticMigration(version: string, sql: string): Migration {
  return {
    version,
    checksum: createHash('sha256').update(sql).digest('hex'),
    statements: splitStatements(sql),
  };
}

/** The same list with extra migrations spliced in directly after a named one. */
export function spliceAfter(
  migrations: readonly Migration[],
  after: string,
  extra: readonly Migration[],
): readonly Migration[] {
  const at = migrations.findIndex((migration) => migration.version === after);
  if (at === -1) throw new Error(`spliceAfter: no migration named ${after}`);
  return [...migrations.slice(0, at + 1), ...extra, ...migrations.slice(at + 1)];
}

/** The first prefix whose proof is not clean, or undefined when all of them are. */
export function firstFailing(proofs: readonly PrefixProof[]): PrefixProof | undefined {
  return proofs.find((proof) => proof.findings.length > 0);
}

export function describePrefix(proof: PrefixProof): string {
  return (
    `${proof.version} (${String(proof.tables)} table(s), schemas ${proof.schemas.join(', ')})\n` +
    proof.findings.map((f) => `    ${f.rule}\n      ${f.object}: ${f.detail}`).join('\n')
  );
}
