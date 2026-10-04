// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
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
