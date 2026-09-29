// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { expect, it, vi } from 'vitest';

const serverUrl = process.env['DATABASE_URL'];
const otherUrl = process.env['FIXTURE_PROOF_OTHER_URL'];

it.skipIf(serverUrl === undefined || otherUrl === undefined)(
  'fallback never creates a database in a container other than the DATABASE_URL server',
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
    const server = postgres(serverUrl ?? '');
    const other = postgres(otherUrl ?? '');
    const templateUrl = new URL(serverUrl ?? '');
    templateUrl.pathname = `/${template}`;
    const reader = postgres(templateUrl.toString(), { max: 1, idle_timeout: 0 });
    const originalArgv = process.argv;
    let createdTemplate = false;
    try {
      const existing = await server`select datname from pg_database where datname = ${template}`;
      if (existing.length === 0) {
        await server.unsafe(`create database "${template}"`);
        createdTemplate = true;
      }
      await reader`select 1`;
      process.argv = ['node', 'tests/fixture/snapshot.ts', 'clone', target];
      vi.resetModules();
      await expect(import('./snapshot.ts')).rejects.toThrow('fixture: dump and restore failed (1)');
      const outside = await other`select datname from pg_database where datname = ${target}`;
      expect(outside).toHaveLength(0);
    } finally {
      process.argv = originalArgv;
      await reader.end();
      await server.unsafe(`drop database if exists "${target}" with (force)`);
      if (createdTemplate) await server.unsafe(`drop database "${template}" with (force)`);
      await other.unsafe(`drop database if exists "${target}" with (force)`);
      await server.end();
      await other.end();
    }
  },
  120_000,
);
