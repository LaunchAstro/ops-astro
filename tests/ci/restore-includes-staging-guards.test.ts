// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { markMadeUp } from '../../scripts/ops/made-up-only.ts';
import { createApiFixture } from '../api/fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { insertPerson } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'restoring a guarded staging database',
  () => {
    it('restores a backup after the staging seed installs its required table guards', async () => {
      const fixture = await createApiFixture('restoreguard');
      try {
        const client = await fixture.db.app.withBusiness(fixture.business, async (tx) => {
          const person = await insertPerson(tx, 'Synthetic client');
          await grantTo(tx, fixture.member, 'read', { kind: 'party', id: person }, false, 'person');
          return person;
        });
        const container = process.env['FIXTURE_PG_CONTAINER'];
        if (!container) throw new Error('the isolated source container must be named');
        const dumpModule = '../../scripts/ops/backup-dump.mjs';
        const { SCHEMAS: schemas } = await import(/* @vite-ignore */ dumpModule);
        const dump = (): Buffer => {
          const result = spawnSync(
            'docker',
            [
              'exec',
              container,
              'pg_dump',
              '-U',
              'postgres',
              '-d',
              fixture.db.name,
              '--format=custom',
              '--role=ops_astro_backup',
              ...schemas.map((schema: string) => `--schema=${schema}`),
            ],
            { maxBuffer: 16 * 1024 * 1024 },
          );
          expect(result.status, 'the source backup must succeed').toBe(0);
          return result.stdout;
        };
        const module = '../../scripts/ops/restore-drill.mjs';
        const sealModule = '../../scripts/ops/archive-seal.mjs';
        const { restoreDrill } = await import(/* @vite-ignore */ module);
        const { sealArchive } = await import(/* @vite-ignore */ sealModule);
        const keys = generateKeyPairSync('rsa', {
          modulusLength: 2048,
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        const restore = async () =>
          await restoreDrill({
            fetchArchive: async () => ({
              takenAt: new Date().toISOString(),
              body: sealArchive(dump(), keys.publicKey),
            }),
            privateKey: keys.privateKey,
            scope: { business: fixture.business, client, person: fixture.member.personId },
          });
        expect(await restore(), 'control before the staging guard is installed').toMatchObject({
          outcome: 'passed',
        });
        await markMadeUp(fixture.db.admin, [fixture.business]);
        const restored = await restore();
        expect(restored, JSON.stringify(restored)).toMatchObject({
          outcome: 'passed',
        });
      } finally {
        await fixture.drop();
      }
    }, 120_000);
  },
);
