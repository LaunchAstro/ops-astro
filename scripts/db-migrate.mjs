// SPDX-License-Identifier: AGPL-3.0-only
//
// Apply the numbered migrations to the local database, in order, once each.
//
// The runner is `packages/core-records/src/tenancy/migrate.ts` and this script
// does not reimplement it. That matters: the ledger, the checksum check on an
// already-applied file, and the rule that a file and its ledger row commit
// together are properties the tenancy tests exercise, and a second
// implementation here would be a second set of properties nobody tests.
//
// It connects as the owner through `DATABASE_ADMIN_URL`, never `DATABASE_URL`.
// The runtime role owns nothing and may create nothing, which is what makes
// runtime DDL a refusal from the server rather than a convention -- so the role
// that runs migrations has to be a different one, and naming it here is part of
// how that stays true.
//
// The runner refuses while anything else is connected to the database, and
// this script offers no way round that: no flag, no environment variable. The
// supported upgrade is the API and GoTrue stopped, this, then both started.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connectAsAdmin } from '../packages/core-records/src/tenancy/database.ts';
import {
  MigrationRefused,
  MigrationRoleCannotSee,
  migrate,
} from '../packages/core-records/src/tenancy/migrate.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/** `.local/db.env` is what `scripts/local/db-up.sh` writes. The environment wins. */
function adminUrl() {
  if (process.env.DATABASE_ADMIN_URL) return process.env.DATABASE_ADMIN_URL;
  const file = `${root}.local/db.env`;
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^DATABASE_ADMIN_URL=(.+)$/u.exec(line.trim());
      if (match) return match[1];
    }
  }
  return undefined;
}

const url = adminUrl();
if (!url) {
  console.error('db-migrate: no DATABASE_ADMIN_URL. Run scripts/local/db-up.sh first.');
  process.exit(1);
}

const admin = connectAsAdmin(url, { source: 'migration' });
try {
  const { applied, alreadyApplied } = await migrate(admin, `${root}migrations`);
  for (const version of alreadyApplied) console.log(`db-migrate: ${version} already applied`);
  for (const version of applied) console.log(`db-migrate: ${version} applied`);
  console.log(
    `db-migrate: ${applied.length} applied, ${alreadyApplied.length} already there, ` +
      `${applied.length + alreadyApplied.length} in the ledger`,
  );
} catch (error) {
  if (!(error instanceof MigrationRefused) && !(error instanceof MigrationRoleCannotSee)) {
    throw error;
  }
  console.error(`db-migrate: ${error.message}`);
  for (const s of error instanceof MigrationRefused ? error.sessions : []) {
    console.error(
      `db-migrate:   connected: pid ${s.pid}, login ${s.usename}, ` +
        `application "${s.application_name ?? ''}", from ${s.client_addr ?? 'local socket'}, ` +
        `since ${s.backend_start}`,
    );
  }
  process.exitCode = 2;
} finally {
  await admin.close();
}
