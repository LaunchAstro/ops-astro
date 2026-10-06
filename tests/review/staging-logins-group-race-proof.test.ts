// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { createEmptyDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';

it('a group granted after the existing-login check cannot be handed out with fresh credentials', async () => {
  const serverUrl = databaseUrlFromEnvironment();
  const container = process.env['FIXTURE_PG_CONTAINER'];
  if (serverUrl === undefined || container === undefined)
    throw new Error('an isolated Postgres container is required');
  const db = await createEmptyDatabase({ part: 'ow066race' });
  const scratch = mkdtempSync(join(tmpdir(), 'ow066-race-'));
  const staging = 'abcdefghijabcdefghij';
  const adminRole = `sol_${randomBytes(4).toString('hex')}.${staging}`;
  try {
    await db.admin.execute(
      `create role "${adminRole}" login createrole password 'synthetic-admin-pw'`,
    );
    await db.admin.execute(`grant ops_astro_app to "${adminRole}" with admin option`);
    await db.admin.execute(`alter database "${db.name}" owner to "${adminRole}"`);
    await db.admin.execute(
      'create role ops_astro_api login inherit nosuperuser nocreatedb nocreaterole nobypassrls noreplication',
    );
    await db.admin.execute(`grant ops_astro_app to ops_astro_api with inherit true`);
    // The project's admin can alter this pre-existing login and its membership.
    await db.admin.execute(`grant ops_astro_api to "${adminRole}" with admin option`);
    const url = new URL(serverUrl);
    url.hostname = 'aws-0-ap-southeast-2.pooler.supabase.com';
    url.username = adminRole;
    url.password = 'synthetic-admin-pw';
    url.pathname = `/${db.name}`;
    url.search = '?sslmode=require';
    const preload = join(scratch, 'interleave.mjs');
    const blocked = join(scratch, 'grant-blocked');
    writeFileSync(
      preload,
      `
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.mkdirSync;
fs.mkdirSync = function(path, options) {
  if (path === process.env.OPS_LOGINS_DIR) {
    const result = spawnSync('docker', ['exec', ${JSON.stringify(container)}, 'psql', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-U', 'postgres', '-d', ${JSON.stringify(db.name)}, '-c', "set lock_timeout='200ms'; grant ops_astro_backup to ops_astro_api"], { encoding: 'utf8' });
    if (result.status !== 0) {
      if (!result.stderr.includes('55P03')) throw new Error('the interleaved grant failed unexpectedly');
      fs.writeFileSync(${JSON.stringify(blocked)}, 'locked');
    }
  }
  return original(path, options);
};
syncBuiltinESMExports();
`,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import=./tests/support/pooler-at-loopback.mjs',
        '--import=./tests/support/plaintext-at-loopback.mjs',
        `--import=${preload}`,
        'scripts/ops/staging-logins.mjs',
        'before-reset',
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'] ?? '',
          STAGING_PROJECT_REF: staging,
          DATABASE_ADMIN_URL: url.toString(),
          OPS_LOGINS_DIR: join(scratch, 'addresses'),
        },
      },
    );
    const [membership] = await db.admin.execute<{ extra: boolean }>(
      "select pg_has_role('ops_astro_api', 'ops_astro_backup', 'member') as extra",
    );
    // A guard may instead hold a lock until credential issuance is complete.
    if (existsSync(blocked)) {
      expect(membership?.extra).toBe(false);
      expect([0, 1]).toContain(result.status);
      return;
    }
    expect(membership?.extra, 'the interleaved group grant committed on another backend').toBe(
      true,
    );
    expect(
      result.status,
      'the command issued fresh credentials after the checked role gained another group',
    ).toBe(1);
  } finally {
    await db.drop();
    const server = connectAsAdmin(serverUrl);
    try {
      await server.execute('drop role if exists ops_astro_api');
      await server.execute(`drop role "${adminRole}"`);
    } finally {
      await server.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});
