// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { expect, it } from 'vitest';

const serverUrl = process.env['DATABASE_URL'];
const container = process.env['FIXTURE_PG_CONTAINER'];

it.skipIf(!serverUrl || !container || process.env['FIXTURE_PROOF_RACE'] !== '1')(
  "ownership proof cleanup preserves another run's template",
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
    const scratch = mkdtempSync(join(tmpdir(), 'fixture-ownership-proof-'));
    const created = join(scratch, 'created');
    const wrapper = join(scratch, 'pnpm');
    writeFileSync(
      wrapper,
      '#!/bin/sh\nset -eu\ndocker exec "$FIXTURE_PG_CONTAINER" createdb -U postgres "$FIXTURE_PROOF_TEMPLATE"\nprintf "%s" "$FIXTURE_PROOF_TEMPLATE" > "$FIXTURE_OTHER_CREATED"\nPATH="$FIXTURE_ORIGINAL_PATH" exec "$FIXTURE_REAL_PNPM" "$@"\n',
      { mode: 0o755 },
    );
    try {
      expect(await server`select datname from pg_database where datname = ${template}`).toHaveLength(0);
      const run = spawnSync(
        process.execPath,
        ['node_modules/vitest/vitest.mjs', 'run', 'tests/ci/fixture-template-ownership-proof.test.ts', '--no-file-parallelism'],
        {
          encoding: 'utf8',
          timeout: 120_000,
          env: {
            ...process.env,
            PATH: `${scratch}:${process.env['PATH'] ?? ''}`,
            FIXTURE_ORIGINAL_PATH: process.env['PATH'] ?? '',
            FIXTURE_REAL_PNPM: execFileSync('which', ['pnpm'], { encoding: 'utf8' }).trim(),
            FIXTURE_PROOF_TEMPLATE: template,
            FIXTURE_OTHER_CREATED: created,
          },
        },
      );
      expect(existsSync(created), run.stdout + run.stderr).toBe(true);
      expect(readFileSync(created, 'utf8')).toBe(template);
      expect(run.status).not.toBe(0);
      expect(run.stdout + run.stderr).toContain('expected undefined to be defined');
      expect(await server`select datname from pg_database where datname = ${template}`).toHaveLength(1);
    } finally {
      await server.unsafe(`drop database if exists "${template}" with (force)`);
      await server.end();
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  120_000,
);
