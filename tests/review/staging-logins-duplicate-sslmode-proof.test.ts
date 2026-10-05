// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { createEmptyDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';

it('duplicate sslmode cannot let staging-logins send verifiers over plaintext', async () => {
  const serverUrl = databaseUrlFromEnvironment();
  if (serverUrl === undefined) throw new Error('an isolated Postgres server is required');
  const db = await createEmptyDatabase({ part: 'ow066tls' });
  const scratch = mkdtempSync(join(tmpdir(), 'ow066-tls-'));
  const staging = 'abcdefghijabcdefghij';
  const adminRole = `sol_${randomBytes(4).toString('hex')}.${staging}`;
  try {
    await db.admin.execute(
      `create role "${adminRole}" login createrole password 'synthetic-admin-pw'`,
    );
    await db.admin.execute(`grant ops_astro_app to "${adminRole}" with admin option`);
    await db.admin.execute(`alter database "${db.name}" owner to "${adminRole}"`);
    const url = new URL(serverUrl);
    url.hostname = 'aws-0-ap-southeast-2.pooler.supabase.com';
    url.username = adminRole;
    url.password = 'synthetic-admin-pw';
    url.pathname = `/${db.name}`;
    url.search = '?sslmode=require&sslmode=disable';
    const environment = {
      PATH: process.env['PATH'] ?? '',
      STAGING_PROJECT_REF: staging,
      DATABASE_ADMIN_URL: url.toString(),
      OPS_LOGINS_DIR: join(scratch, 'addresses'),
    };
    const result = spawnSync(
      process.execPath,
      [
        '--import=./tests/support/pooler-at-loopback.mjs',
        'scripts/ops/staging-logins.mjs',
        'before-reset',
      ],
      { env: environment, encoding: 'utf8' },
    );
    // No plaintext test allowance was loaded: success means the URL alone bypassed TLS.
    if (result.status === 0) expect(result.stdout).toContain('login(s) set');
    expect(
      result.status,
      'the command must refuse this plaintext connection before changing logins',
    ).toBe(1);
  } finally {
    const server = connectAsAdmin(serverUrl);
    try {
      await db.drop();
      await server.execute('drop role if exists ops_astro_api');
      await server.execute(`drop role "${adminRole}"`);
    } finally {
      await server.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});
