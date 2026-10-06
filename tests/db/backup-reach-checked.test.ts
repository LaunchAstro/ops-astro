// SPDX-License-Identifier: AGPL-3.0-only
//
// #999, 20261006140500: the backup identity reads every schema the dump names
// that is ours to grant on, or the migration stops and names the gap. Staging's
// made-up guard, made before the migrations, is granted; hosted Supabase's
// platform-owned `auth` is left to the platform, never granted by its roles.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMigrations } from '../../packages/core-records/src/tenancy/migrate.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import {
  asRole,
  attempt,
  BACKUP,
  Client,
  dropLogins,
  loginIn,
  serverUrl,
} from './backup-identity.fixture.ts';

const STATEMENTS =
  readMigrations('migrations').find((m) => m.version === '20261006140500_backup_reach_checked')
    ?.statements ?? [];

let db: FreshDatabase;
let login: { url: string; name: string };
let owner: string;

/** The migration's statements, run in one session as `role` (the database owner when unset). */
async function migrateAs(role?: string): Promise<string> {
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${db.name}`;
  const client = new Client(url.toString());
  try {
    if (role !== undefined) await client.query(`set role "${role}"`);
    for (const statement of STATEMENTS) {
      // oxlint-disable-next-line no-await-in-loop -- in order, as the runner applies them
      await client.query(statement);
    }
    return 'ok';
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    return `${code ?? 'failed'} ${message ?? ''}`;
  } finally {
    await client.end();
  }
}

describe.skipIf(serverUrl === undefined)('S0-3 backup reach checked', () => {
  beforeAll(async () => {
    expect(STATEMENTS.length).toBeGreaterThan(0);
    db = await createFreshDatabase({ part: 'bk999' });
    login = await loginIn(db, BACKUP, 'b9');
    owner = `${db.name}_own`;
    await db.admin.execute(`create role "${owner}" nologin`);
  }, 120_000);

  afterAll(async () => {
    await dropLogins(
      db,
      [login?.name, owner].filter((n): n is string => n !== undefined),
    );
  });

  guardGranted();
  unreadTableStops();
  hostedAuthLeftOut();
});

function guardGranted(): void {
  it('grants the made-up guard made before the default privileges, so the backup reads it', async () => {
    // As on staging: the guard is made first, with no grant to the backup identity.
    await db.admin.execute('create schema ops_astro_made_up');
    await db.admin.execute('create table ops_astro_made_up.untrusted (relation text primary key)');
    await db.admin.execute('revoke all on schema ops_astro_made_up from ops_astro_backup');
    await db.admin.execute('revoke all on ops_astro_made_up.untrusted from ops_astro_backup');
    const backup = await asRole(login.url, BACKUP);
    try {
      expect(await attempt(backup, 'select * from ops_astro_made_up.untrusted')).toBe('42501');
      expect(await migrateAs()).toBe('ok');
      expect(await attempt(backup, 'select * from ops_astro_made_up.untrusted')).toBe('ok');
    } finally {
      await backup.end();
      await db.admin.execute('drop schema ops_astro_made_up cascade');
    }
  });
}

function unreadTableStops(): void {
  it('stops, naming the table, when a table the dump reads is unreadable to the backup', async () => {
    await db.admin.execute('create table ops.unread_by_backup (id int)');
    await db.admin.execute('revoke all on ops.unread_by_backup from ops_astro_backup');
    try {
      const outcome = await migrateAs();
      expect(outcome).toMatch(/^42501 /u);
      expect(outcome).toContain('ops.unread_by_backup');
    } finally {
      await db.admin.execute('drop table ops.unread_by_backup');
    }
  });
}

function hostedAuthLeftOut(): void {
  it('leaves a platform-owned auth schema out, and checks one the migrating owner holds', async () => {
    const platform = `${db.name}_plt`;
    await db.admin.execute(`create role "${platform}" nologin`);
    try {
      await db.admin.execute(`create schema auth authorization "${platform}"`);
      await db.admin.execute('create table auth.users (id uuid primary key)');
      await db.admin.execute(`alter table auth.users owner to "${platform}"`);
      // Hosted Supabase: our owner may use auth, not grant on it; the backup reads nothing there.
      await db.admin.execute(`grant usage on schema auth to "${owner}"`);
      expect(await migrateAs(owner)).toBe('ok');
      // The same schema owned by the migrating owner is ours, so its gap stops the run.
      await db.admin.execute(`alter schema auth owner to "${owner}"`);
      await db.admin.execute(`alter table auth.users owner to "${owner}"`);
      const outcome = await migrateAs(owner);
      expect(outcome).toMatch(/^42501 /u);
      expect(outcome).toContain('schema auth');
      expect(outcome).toContain('auth.users');
    } finally {
      await db.admin.execute('drop schema if exists auth cascade');
      await db.admin.execute(`drop role if exists "${platform}"`);
    }
  });
}
