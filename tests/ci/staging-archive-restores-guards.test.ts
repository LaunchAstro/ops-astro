// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { markMadeUp } from '../../scripts/ops/made-up-only.ts';
import { createApiFixture } from '../api/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)('complete staging archive restore', () => {
  it('restores a guarded staging archive with its guard triggers intact', async () => {
    const fixture = await createApiFixture('guardarchive');
    const container = process.env['FIXTURE_PG_CONTAINER'];
    if (!container) throw new Error('the isolated source container must be named');
    const target = `review_guard_${randomBytes(5).toString('hex')}`;
    const docker = (args: string[], input?: Buffer) =>
      spawnSync('docker', ['exec', ...(input ? ['-i'] : []), container, ...args], {
        input,
        maxBuffer: 16 * 1024 * 1024,
      });
    try {
      await markMadeUp(fixture.db.admin, [fixture.business]);
      const archive = docker([
        'pg_dump', '-U', 'postgres', '-d', fixture.db.name, '--format=custom',
        '--role=ops_astro_backup', '--schema=public', '--schema=ops', '--schema=auth',
      ]);
      expect(archive.status, 'the scheduled dump must succeed').toBe(0);
      expect(docker(['createdb', '-U', 'postgres', target]).status).toBe(0);
      expect(docker(['psql', '-U', 'postgres', '-d', target, '-c', 'drop schema public']).status).toBe(0);
      const restored = docker([
        'pg_restore', '-U', 'postgres', '-d', target, '--exit-on-error',
        '--single-transaction', '--no-owner', '--no-privileges',
      ], archive.stdout);
      expect(restored.stderr.toString(), 'the restore must reach the made-up guard dependency').toMatch(/ops_astro_made_up/u);
      expect(restored.status, 'the complete archive must restore without dropping guards').toBe(0);
    } finally {
      docker(['dropdb', '-U', 'postgres', '--if-exists', '--force', target]);
      await fixture.drop();
    }
  }, 120_000);
});
