// SPDX-License-Identifier: AGPL-3.0-only
//
// T4a's clone past a reader dumps and restores inside FIXTURE_PG_CONTAINER.
// Pointed at a container that runs another server, the clone refuses, names
// the container and the variable, and creates nothing on either server. The
// case needs a second throwaway server: FIXTURE_PROOF_OTHER_URL, with
// FIXTURE_PG_CONTAINER naming that server's container. Run it one file at a
// time (--no-file-parallelism) beside the other suites that hold a reader on
// the template: they share its one name, and each makes and drops it.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { expect, it, vi } from 'vitest';

const serverUrl = process.env['DATABASE_URL'];
const otherUrl = process.env['FIXTURE_PROOF_OTHER_URL'];
const container = process.env['FIXTURE_PG_CONTAINER'];

it.skipIf(serverUrl === undefined || otherUrl === undefined || container === undefined)(
  'the clone fallback refuses a container running another server, by name, creating nothing',
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
    const target = `fixture_refused_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const server = postgres(serverUrl ?? '', { onnotice: () => undefined });
    const other = postgres(otherUrl ?? '', { onnotice: () => undefined });
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
      await expect(import('../fixture/snapshot.ts')).rejects.toThrow(
        `fixture: container ${container ?? ''} is not the DATABASE_URL server;` +
          ' set FIXTURE_PG_CONTAINER to its container. Nothing was created.',
      );
      const made = async (sql: postgres.Sql) =>
        await sql`select datname from pg_database where datname = ${target}`;
      expect([...(await made(server)), ...(await made(other))]).toHaveLength(0);
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
