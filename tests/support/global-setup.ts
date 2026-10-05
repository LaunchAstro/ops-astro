// SPDX-License-Identifier: AGPL-3.0-only
//
// Once per run, before any test file: make the cluster-wide roles exist.
//
// Every database-bound file builds its own database in `beforeAll`, and on a
// brand-new cluster the first of them to run creates two roles that every
// database then shares: `ops_astro_app` (the harness, `fresh-database.ts`) and
// `ops_astro_worker` (`migrations/0008_agent_authority.sql`). Both guard the
// create with `if not exists`, but the check and the create are not atomic, so
// files starting side by side race and all but one fail on
// `pg_authid_rolname_index`. A warm cluster never shows it.
//
// So this migrates one database from empty, which creates both roles exactly as
// the product does: the migrated template every fresh database is cloned from,
// or, with OPS_ASTRO_DB_TEMPLATE=off, a throwaway one it drops again. The group roles stay (roles
// are per cluster, and `drop()` removes only its own login roles). Nothing is
// duplicated here: a role a later migration adds is made by the same call.
// With no database configured it does nothing, and the database-bound files
// report their own missing URL as before.
//
// It does all of this through a database beside the configured one, never the
// configured one itself. `scripts/db-conformance.mjs` proves a named suite
// reached the database by reading `pg_stat_database` for the configured
// database either side of the suite's own vitest run, and this setup runs
// inside that run. Worked through the configured database, the warm-up moved
// that counter by 15 and even the roles check alone by more than a read costs,
// so a suite that never touched the database looked as if it had. Roles and
// `pg_roles` are cluster-wide, so the database this connects to changes
// nothing about what it creates.

import {
  APPLICATION_ROLE,
  createFreshDatabase,
  databaseUrlFromEnvironment,
} from './fresh-database.ts';
import { besideUrl, ensureMigratedTemplate, templateEnabled } from './migrated-template.ts';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';

const SHARED_ROLES = [APPLICATION_ROLE, 'ops_astro_worker'] as const;

export { besideUrl };

export default async function setup(): Promise<void> {
  const configuredUrl = databaseUrlFromEnvironment();
  if (configuredUrl === undefined) return;
  // The migrated template (migrated-template.ts) is built from empty here, once,
  // before any file clones it; building it makes the shared roles too.
  if (templateEnabled()) {
    await ensureMigratedTemplate(configuredUrl);
    return;
  }
  const serverUrl = besideUrl(configuredUrl);

  const server = connectAsAdmin(serverUrl);
  let present: number;
  try {
    const rows = await server.execute<{ count: string }>(
      'select count(*)::text as count from pg_roles where rolname = any($1::text[])',
      [SHARED_ROLES],
    );
    present = Number(rows[0]?.count ?? '0');
  } finally {
    await server.close();
  }
  if (present === SHARED_ROLES.length) return;

  const warm = await createFreshDatabase({ serverUrl, part: 'roles' });
  await warm.drop();
}
