// SPDX-License-Identifier: AGPL-3.0-only
//
// Vouch for a new local database before its first sign-in is written.
//
// The made-up guard (scripts/ops/made-up-only.ts) opens an unmarked database
// only while no tenant or sign-in table has ever held a row, and `auth:seed`
// writes `auth.users` rows through GoTrue. So this runs between `auth:up` and
// `auth:seed` (docs/local/README.md): the seed's own admission, then the mark.
// From then on the guard judges each sign-in as it is written, and `db:seed`
// finds a marked database. Run again, it judges the marked database and keeps
// its mark. It reads no tenant or sign-in row and writes none.

import { fileURLToPath } from 'node:url';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { readEnvFile } from '../../packages/core-records/src/env-file.ts';
import { admitBeforeSignIns } from '../ops/made-up-only.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const local = process.env['OPS_SEED_DIR'] || `${root}.local`;
const adminUrl =
  process.env['DATABASE_ADMIN_URL'] || readEnvFile(`${local}/db.env`)['DATABASE_ADMIN_URL'];
if (!adminUrl) {
  console.error('db-admit: no DATABASE_ADMIN_URL. Run scripts/local/db-up.sh.');
  process.exit(1);
}

const admin = connectAsAdmin(adminUrl, { source: 'seed' });
try {
  const signs = await admitBeforeSignIns(admin, process.env['LOCAL_SEED_MADE_UP'] === 'confirm');
  if (signs.length > 0) {
    console.error(`db-admit: REFUSED, not provably made-up data: ${signs.join('; ')}.`);
    console.error('db-admit: a person confirms a new database once: LOCAL_SEED_MADE_UP=confirm');
    process.exitCode = 1;
  } else {
    console.log('db-admit: the database is marked made-up and guarded; auth:seed may write');
  }
} finally {
  await admin.close();
}
