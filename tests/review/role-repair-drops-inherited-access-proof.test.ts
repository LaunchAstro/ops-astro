// SPDX-License-Identifier: AGPL-3.0-only
// Run alone on a disposable cluster: two cases deliberately seed stale role memberships.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { createEmptyDatabase } from '../support/fresh-database.ts';

const migrations = readMigrations('migrations');

async function seed(db: Awaited<ReturnType<typeof createEmptyDatabase>>, key: string) {
  const business = randomUUID();
  const person = randomUUID();
  const actor = randomUUID();
  await db.admin.execute(
    'insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $2)',
    [business, key],
  );
  await db.admin.execute(
    'insert into public.people (business_id, id, display_name) values ($1, $2, $3)',
    [business, person, key],
  );
  await db.admin.execute(
    "insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)",
    [business, actor, person],
  );
  return { business, person, actor };
}

it('the populated pre-range main schema upgrades to the frozen head', async () => {
  const db = await createEmptyDatabase({ part: 'solow007_upgrade' });
  try {
    await applyMigrations(
      db.admin,
      migrations.filter((m) => m.version.slice(0, 4) <= '0041'),
    );
    const { person } = await seed(db, 'sol-upgrade');
    await applyMigrations(db.admin, migrations);
    expect(
      await db.admin.execute('select display_name from public.people where id = $1', [person]),
    ).toEqual([{ display_name: 'sol-upgrade' }]);
    expect(
      await db.admin.execute('select version from ops.schema_migrations order by version'),
    ).toEqual(migrations.map(({ version }) => ({ version })));
  } finally {
    await db.drop();
  }
});

it('migrating an existing lookup identity removes inherited access across businesses and people', async () => {
  const db = await createEmptyDatabase({ part: 'solow007_lookup' });
  try {
    await applyMigrations(
      db.admin,
      migrations.filter((m) => m.version.slice(0, 4) <= '0041'),
    );
    await seed(db, 'sol-alpha');
    await seed(db, 'sol-bravo');
    await db.admin.execute(
      'do $$ begin create role ops_astro_lookup nologin; exception when duplicate_object then null; end $$',
    );
    // A manually prepared role can inherit application grants while still being subject to RLS.
    await db.admin.execute('alter role ops_astro_lookup nobypassrls');
    await db.admin.execute('grant ops_astro_app to ops_astro_lookup');
    const before = await db.admin.transaction(async (query) => {
      await query('set local role ops_astro_lookup');
      return query('select * from public.people');
    });
    expect(before).toEqual([]);
    await applyMigrations(db.admin, migrations);
    const read = await db.admin
      .transaction(async (query) => {
        await query('set local role ops_astro_lookup');
        return query('select display_name from public.people order by display_name');
      })
      .then(
        (rows) => ({ code: 'ok', rows }),
        (error: { code: string }) => ({ code: error.code, rows: [] }),
      );
    expect(read).toEqual({ code: '42501', rows: [] });
  } finally {
    await db.admin.execute('revoke ops_astro_app from ops_astro_lookup');
    await db.admin.execute('alter role ops_astro_lookup bypassrls');
    await db.drop();
  }
});

it('migrating an existing backup identity removes inherited write privileges', async () => {
  const db = await createEmptyDatabase({ part: 'solow007_backup' });
  try {
    await applyMigrations(
      db.admin,
      migrations.filter((m) => m.version.slice(0, 4) <= '0041'),
    );
    const { person } = await seed(db, 'sol-backup');
    await db.admin.execute(
      'do $$ begin create role ops_astro_backup nologin; exception when duplicate_object then null; end $$',
    );
    await db.admin.execute('alter role ops_astro_backup nobypassrls');
    await db.admin.execute('grant ops_astro_app to ops_astro_backup');
    expect(
      await db.admin.transaction(async (query) => {
        await query('set local role ops_astro_backup');
        return query(
          "update public.people set display_name = 'Changed by backup' where id = $1 returning id",
          [person],
        );
      }),
    ).toEqual([]);
    await applyMigrations(db.admin, migrations);
    const write = await db.admin
      .transaction(async (query) => {
        await query('set local role ops_astro_backup');
        return query(
          "update public.people set display_name = 'Changed by backup' where id = $1 returning id",
          [person],
        );
      })
      .then(
        () => 'ok',
        (error: { code: string }) => error.code,
      );
    expect(write).toBe('42501');
  } finally {
    await db.admin.execute('revoke ops_astro_app from ops_astro_backup');
    await db.admin.execute('alter role ops_astro_backup bypassrls');
    await db.drop();
  }
});
