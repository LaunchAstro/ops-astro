// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { markMadeUp } from '../../scripts/ops/made-up-only.ts';
import { createApiFixture } from '../api/fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { insertPerson } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)('the complete guarded drill target', () => {
  it('restores the staging guard triggers during the scheduled drill', async () => {
    const fixture = await createApiFixture('guarddrill');
    try {
      const client = await fixture.db.app.withBusiness(fixture.business, async (tx) => {
        const person = await insertPerson(tx, 'Synthetic client');
        await grantTo(tx, fixture.member, 'read', { kind: 'party', id: person }, false, 'person');
        return person;
      });
      await markMadeUp(fixture.db.admin, [fixture.business]);
      const container = process.env['FIXTURE_PG_CONTAINER'];
      if (!container) throw new Error('the isolated source container must be named');
      const dumpModule = '../../scripts/ops/backup-dump.mjs';
      const sealModule = '../../scripts/ops/archive-seal.mjs';
      const dockerModule = '../../scripts/ops/drill-docker.mjs';
      const restoreModule = '../../scripts/ops/drill-restore.mjs';
      const { SCHEMAS: schemas } = await import(/* @vite-ignore */ dumpModule);
      const { sealArchive } = await import(/* @vite-ignore */ sealModule);
      const { docker } = await import(/* @vite-ignore */ dockerModule);
      const { restoreDrill } = await import(/* @vite-ignore */ restoreModule);
      const archive = spawnSync('docker', [
        'exec', container, 'pg_dump', '-U', 'postgres', '-d', fixture.db.name,
        '--format=custom', '--role=ops_astro_backup',
        ...schemas.map((schema: string) => `--schema=${schema}`),
      ], { maxBuffer: 16 * 1024 * 1024 });
      expect(archive.status, 'the scheduled dump must succeed').toBe(0);
      const keys = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      let restoredGuards: number | undefined;
      const run = async (args: string[], input?: Buffer) => {
        const result = await docker(args, input);
        if (args[0] === 'exec' && args.includes('pg_restore') && args.includes('--single-transaction') && result.code === 0) {
          const target = args[2]!;
          const count = await docker([
            'exec', target, 'psql', '-U', 'postgres', '-d', 'drill', '-Atq', '-c',
            "select count(*) from pg_trigger where tgname = 'ops_astro_made_up_guard' and not tgisinternal",
          ]);
          expect(count.code).toBe(0);
          restoredGuards = Number(count.stdout.trim());
        }
        return result;
      };
      const result = await restoreDrill({
        fetchArchive: async () => ({
          takenAt: new Date().toISOString(),
          body: sealArchive(archive.stdout, keys.publicKey),
        }),
        privateKey: keys.privateKey,
        scope: { business: fixture.business, client, person: fixture.member.personId },
        docker: run,
      });
      expect(result.outcome, JSON.stringify(result)).toBe('passed');
      expect(restoredGuards, 'the drill target must retain the staging guard triggers').toBeGreaterThan(0);
    } finally {
      await fixture.drop();
    }
  }, 120_000);
});
