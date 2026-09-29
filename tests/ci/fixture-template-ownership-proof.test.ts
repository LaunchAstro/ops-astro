// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { expect, it } from 'vitest';

const serverUrl = process.env['DATABASE_URL'];
const container = process.env['FIXTURE_PG_CONTAINER'];

it.skipIf(!serverUrl || !container || process.env['FIXTURE_PROOF_RACE'] !== '1')(
  'snapshot build cleanup preserves a template another run created before rename',
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
    const server = postgres(serverUrl ?? '');
    const scratch = mkdtempSync(join(tmpdir(), 'fixture-race-proof-'));
    const marker = join(scratch, 'created-template');
    try {
      expect(await server`select datname from pg_database where datname = ${template}`).toHaveLength(0);
      const run = spawnSync(
        'pnpm',
        [
          'vitest', 'run', '--config', 'tests/support/fixture-race-vitest.config.mjs',
          'tests/fixture/snapshot/snapshot-clone-and-privileges.test.ts',
          '--no-file-parallelism', '-t', 'building a snapshot completes and leaves a cloneable template',
        ],
        {
          encoding: 'utf8',
          timeout: 120_000,
          env: { ...process.env, FIXTURE_RACE_MARKER: marker },
        },
      );
      expect(existsSync(marker), run.stdout + run.stderr).toBe(true);
      expect(readFileSync(marker, 'utf8')).toBe(template);
      expect(run.status).not.toBe(0);
      expect(run.stdout + run.stderr).toContain(`database "${template}" already exists`);
      expect(await server`select datname from pg_database where datname = ${template}`).toHaveLength(1);
    } finally {
      await server.unsafe(`drop database if exists "${template}" with (force)`);
      await server.end();
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  120_000,
);
