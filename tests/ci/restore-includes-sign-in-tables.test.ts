// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApiFixture } from '../api/fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { insertPerson } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'restoring the scheduled backup with sign-in data',
  () => {
    it('passes for the complete public, ops and auth archive that the backup job takes', async () => {
      const fixture = await createApiFixture('restoreauth');
      try {
        const client = await fixture.db.app.withBusiness(fixture.business, async (tx) => {
          const person = await insertPerson(tx, 'Synthetic client');
          await grantTo(tx, fixture.member, 'read', { kind: 'party', id: person }, false, 'person');
          return person;
        });
        await fixture.db.admin.execute(
          'create schema auth; create table auth.users (id uuid primary key); insert into auth.users values (gen_random_uuid())',
        );
        const container = process.env['FIXTURE_PG_CONTAINER'];
        if (!container) throw new Error('the isolated source container must be named');
        const dump = (auth: boolean): Buffer => {
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
              '--schema=public',
              '--schema=ops',
              ...(auth ? ['--schema=auth'] : []),
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
        const restore = async (auth: boolean) =>
          await restoreDrill({
            fetchArchive: async () => ({
              takenAt: new Date().toISOString(),
              body: sealArchive(dump(auth), keys.publicKey),
            }),
            privateKey: keys.privateKey,
            scope: { business: fixture.business, client, person: fixture.member.personId },
          });
        expect(await restore(false), 'control without the auth schema').toMatchObject({
          outcome: 'passed',
        });
        const restored = await restore(true);
        expect(restored, JSON.stringify(restored)).toMatchObject({
          outcome: 'passed',
        });
      } finally {
        await fixture.drop();
      }
    }, 120_000);
  },
);
