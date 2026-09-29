// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { expect, it, vi } from 'vitest';

const databaseUrl = process.env['DATABASE_URL'];
const adminUrl = process.env['FIXTURE_PROOF_OTHER_URL'];
const otherContainer = process.env['FIXTURE_PG_CONTAINER'];

it.skipIf(!databaseUrl || !adminUrl || !otherContainer)(
  'fallback refuses the admin container when DATABASE_URL names another server',
  async () => {
    const hash = createHash('sha256');
    const sources = [
      ...readdirSync('migrations')
        .filter((name) => name.endsWith('.sql'))
        .toSorted()
        .map((name) => `migrations/${name}`),
      ...['shape', 'cast', 'generate'].map((name) => `tests/fixture/${name}.ts`),
    ];
    for (const source of sources) hash.update(source).update(readFileSync(source));
    const template = `fixture_${hash.digest('hex').slice(0, 16)}`;
    const target = `fixture_proof_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const other = postgres(adminUrl ?? '');
    const templateUrl = new URL(adminUrl ?? '');
    templateUrl.pathname = `/${template}`;
    const reader = postgres(templateUrl.toString(), { max: 1, idle_timeout: 0 });
    const originalAdminUrl = process.env['DATABASE_ADMIN_URL'];
    const originalArgv = process.argv;
    let createdTemplate = false;
    try {
      const existing = await other`select datname from pg_database where datname = ${template}`;
      if (existing.length === 0) {
        await other.unsafe(`create database "${template}"`);
        createdTemplate = true;
      }
      await reader`select 1`;
      process.env['DATABASE_ADMIN_URL'] = adminUrl ?? '';
      process.argv = ['node', 'tests/fixture/snapshot/snapshot.ts', 'clone', target];
      vi.resetModules();
      await expect(import('../fixture/snapshot/snapshot.ts')).rejects.toThrow(
        `fixture: container ${otherContainer ?? ''} is not the DATABASE_URL server`,
      );
      expect(await other`select datname from pg_database where datname = ${target}`).toHaveLength(
        0,
      );
    } finally {
      if (originalAdminUrl === undefined) delete process.env['DATABASE_ADMIN_URL'];
      else process.env['DATABASE_ADMIN_URL'] = originalAdminUrl;
      process.argv = originalArgv;
      await reader.end();
      await other.unsafe(`drop database if exists "${target}" with (force)`);
      if (createdTemplate) await other.unsafe(`drop database "${template}" with (force)`);
      await other.end();
    }
  },
  120_000,
);
