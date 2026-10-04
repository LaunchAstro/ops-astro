// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  connectAsAdmin,
  type AdminConnection,
} from '../../packages/core-records/src/tenancy/database.ts';
import { catalogueOf, databaseFactsOf } from './database-catalogue.ts';
import { createFreshDatabase, databaseUrlFromEnvironment } from './fresh-database.ts';
import { besideUrl, ensureMigratedTemplate } from './migrated-template.ts';

it('configured databases on one server share the template builder lock', async () => {
  const configured = databaseUrlFromEnvironment();
  expect(configured).toBeDefined();
  const url = new URL(configured ?? '');
  url.pathname = '/conformance';
  const held = connectAsAdmin(besideUrl(url.toString()));
  url.pathname = '/postgres';
  const name = `migrated_sol_${randomBytes(6).toString('hex')}`;
  let building: ReturnType<typeof ensureMigratedTemplate> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await held.execute("select pg_advisory_lock(hashtext('ops-astro migrated template'))");
    building = ensureMigratedTemplate(url.toString(), name);
    const first = await Promise.race([
      building.then(() => 'built while the other builder held its lock'),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('waiting for the shared lock'), 15_000);
      }),
    ]);
    expect(first).toBe('waiting for the shared lock');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await held.execute("select pg_advisory_unlock(hashtext('ops-astro migrated template'))");
    await building;
    await held.execute(`drop database if exists "${name}" with (force)`);
    await held.close();
  }
}, 60_000);

it('the clone catalogue comparison sees a disabled budget ceiling trigger', async () => {
  const db = await createFreshDatabase({ part: 'solcatalogue' });
  try {
    const before = await catalogueOf(db.admin);
    await db.admin.execute(
      'alter table public.budget_caps disable trigger budget_caps_limit_within_ceiling',
    );
    const state = await db.admin.execute<{ enabled: string }>(
      "select tgenabled enabled from pg_trigger where tgrelid = 'public.budget_caps'::regclass and tgname = 'budget_caps_limit_within_ceiling'",
    );
    expect(state[0]?.enabled).toBe('D');
    expect(await catalogueOf(db.admin)).not.toStrictEqual(before);
  } finally {
    await db.drop();
  }
});

it('the clone privilege comparison sees a login lose its role membership inheritance', async () => {
  const db = await createFreshDatabase({ part: 'solmembership' });
  try {
    const before = await databaseFactsOf(db.admin, db.name);
    const usage = async () =>
      (
        await db.admin.execute<{ usable: boolean }>(
          "select pg_has_role($1, 'ops_astro_app', 'usage') usable",
          [db.loginRole],
        )
      )[0]?.usable;
    expect(await usage()).toBe(true);
    await db.admin.execute(`grant ops_astro_app to "${db.loginRole}" with inherit false`);
    expect(await usage()).toBe(false);
    expect(await databaseFactsOf(db.admin, db.name)).not.toStrictEqual(before);
  } finally {
    await db.drop();
  }
});

/**
 * The server URL configured for `postgres`, whose builder works beside it in
 * template1: the database a plain `create database` copies, and refuses to
 * copy while anyone else is connected to it.
 */
function configuredForPostgres(): string {
  const url = new URL(databaseUrlFromEnvironment() ?? '');
  url.pathname = '/postgres';
  return url.toString();
}

/** Polls until a backend waits on a lock: of kind `event`, or in `database`. */
async function untilWaiting(
  server: AdminConnection,
  { event, database }: { event?: string; database?: string },
): Promise<void> {
  for (let tries = 0; tries < 600; tries++) {
    // oxlint-disable-next-line no-await-in-loop -- one poll after another
    const [row] = await server.execute<{ n: string }>(
      `select count(*)::text n from pg_stat_activity
        where wait_event_type = 'Lock' and ($1::text is null or wait_event = $1)
          and ($2::text is null or datname = $2)`,
      [event ?? null, database ?? null],
    );
    if (row?.n !== '0') return;
    // oxlint-disable-next-line no-await-in-loop -- one poll after another
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error('no backend waited on the lock');
}

/** A plain `create database`, which copies template1, and its drop. */
async function plainCreate(server: AdminConnection): Promise<void> {
  const name = `t1_tplplain_${randomBytes(6).toString('hex')}`;
  await server.execute(`create database "${name}"`);
  await server.execute(`drop database "${name}"`);
}

/** A promise and the call that settles it. */
function gate(): { readonly passed: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { passed, open };
}

const LOCK_KEY = "hashtext('ops-astro migrated template')";

it('a builder waiting on the template lock holds template1 for nobody', async () => {
  const name = `migrated_wait_${randomBytes(6).toString('hex')}`;
  const held = connectAsAdmin(configuredForPostgres());
  let building: Promise<unknown> | undefined;
  try {
    await held.execute(`select pg_advisory_lock(${LOCK_KEY})`);
    building = ensureMigratedTemplate(configuredForPostgres(), name);
    await untilWaiting(held, { event: 'advisory' });
    await plainCreate(held);
  } finally {
    await held.execute(`select pg_advisory_unlock(${LOCK_KEY})`);
    await building;
    await held.execute(`drop database if exists "${name}" with (force)`);
    await held.close();
  }
}, 120_000);

it('a builder holds template1 for nobody while its migrations run', async () => {
  const name = `migrated_run_${randomBytes(6).toString('hex')}`;
  const server = connectAsAdmin(configuredForPostgres());
  const watch = connectAsAdmin(configuredForPostgres());
  const rolledBack = new Error('rolled back');
  const holding = gate();
  const release = gate();
  let blocking = Promise.resolve();
  let building: Promise<unknown> | undefined;
  try {
    // 0008 comments on this cluster-wide role, so a migration from empty
    // waits on this open transaction, part way through migrate().
    blocking = server
      .transaction(async (execute) => {
        await execute("comment on role ops_astro_worker is 'held by a test'");
        holding.open();
        await release.passed;
        throw rolledBack;
      })
      .catch((error: unknown) => {
        if (error !== rolledBack) throw error;
      });
    await holding.passed;
    building = ensureMigratedTemplate(configuredForPostgres(), name);
    await untilWaiting(watch, { database: name });
    await plainCreate(watch);
  } finally {
    release.open();
    await blocking;
    await building;
    await watch.execute(`drop database if exists "${name}" with (force)`);
    await Promise.all([server.close(), watch.close()]);
  }
}, 300_000);

it('the clone catalogue comparison sees a foreign key stop being enforced', async () => {
  const db = await createFreshDatabase({ part: 'fkdisabled' });
  try {
    // A table with a foreign key and no trigger of its own, so only the
    // foreign key's internal triggers change.
    const [table] = await db.admin.execute<{ name: string }>(
      `select k.conrelid::regclass::text name from pg_constraint k
        where k.contype = 'f' and k.connamespace = 'public'::regnamespace
          and not exists (select 1 from pg_trigger t where t.tgrelid = k.conrelid and not t.tgisinternal)
        order by 1 limit 1`,
    );
    expect(table?.name).toBeDefined();
    const before = await catalogueOf(db.admin);
    await db.admin.execute(`alter table ${table?.name ?? ''} disable trigger all`);
    const [disabled] = await db.admin.execute<{ n: string }>(
      `select count(*)::text n from pg_trigger
        where tgrelid = $1::regclass and tgisinternal and tgenabled = 'D'`,
      [table?.name],
    );
    expect(disabled?.n).not.toBe('0');
    expect(await catalogueOf(db.admin)).not.toStrictEqual(before);
  } finally {
    await db.drop();
  }
});
