// SPDX-License-Identifier: AGPL-3.0-only
//
// A test database standing where a hosted Supabase project stands: the
// Realtime shim first, then every migration from empty, so the migrations'
// guarded Realtime statements run. The migrated template has no shim, which
// is the other case: the migrations applied where Realtime is absent.

import { readFileSync } from 'node:fs';
import { migrate } from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from './fresh-database.ts';

const SHIM = readFileSync(new URL('realtime-shim.sql', import.meta.url), 'utf8');

export interface RealtimeDatabase extends EmptyDatabase {
  /** The owner's URL to this database, for the hub's own connections. */
  readonly adminUrl: string;
}

export async function createRealtimeDatabase(part: string): Promise<RealtimeDatabase> {
  const serverUrl = databaseUrlFromEnvironment();
  if (serverUrl === undefined) throw new Error('no database server');
  const empty = await createEmptyDatabase({ serverUrl, part });
  try {
    await empty.admin.transaction(async (execute) => {
      await execute(SHIM);
    });
    await migrate(empty.admin, 'migrations');
  } catch (error) {
    await empty.drop();
    throw error;
  }
  const url = new URL(serverUrl);
  url.pathname = `/${empty.name}`;
  return Object.assign(empty, { adminUrl: url.toString() });
}
