// SPDX-License-Identifier: AGPL-3.0-only
//
// M01 and M02. The migrations apply from empty in order, and the tenancy
// catalogue, the composite-key linter and default deny hold after every one of
// them -- not merely after the last.
//
// The prefixes are read from `migrations/`, never listed here. A lane adding
// `0008_runtime.sql` adds the file and this suite covers it, because the only
// thing that would otherwise cover the newest migration is somebody
// remembering to extend a list.
//
// The third role is the point of the default-deny half. The owner builds, the
// application role is granted what the migrations grant it, and a restricted
// login that is a member of nothing stands for every other role the cluster
// will ever have. It connects here, so its refusals are the server's.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  describePrefix,
  firstFailing,
  proveEachPrefix,
  spliceAfter,
  syntheticMigration,
  type PrefixProof,
} from '../../packages/core-records/src/tenancy/testing/prefix-harness.ts';
import { readMigrations } from '../../packages/core-records/src/tenancy/migrate.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'migration prefixes: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const onDisk = readMigrations('migrations');

describe.skipIf(serverUrl === undefined)('M01/M02: every migration prefix', () => {
  let db: EmptyDatabase;
  let proofs: readonly PrefixProof[];

  beforeAll(async () => {
    db = await createEmptyDatabase({ part: 'p' });
    proofs = await proveEachPrefix(db, onDisk);
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('the prefixes the harness covered', () => {
    it('is every migration in the directory, in order, from the first', () => {
      expect(proofs.map((proof) => proof.version)).toStrictEqual(
        onDisk.map((migration) => migration.version),
      );
      expect(proofs.length).toBeGreaterThan(1);
      expect(proofs[0]?.through).toStrictEqual([onDisk[0]?.version]);
    });

    it('checked a real schema at every one of them, never an empty catalogue', () => {
      for (const proof of proofs) {
        expect({ version: proof.version, tables: proof.tables > 0 }).toStrictEqual({
          version: proof.version,
          tables: true,
        });
      }
    });

    it('names the schemas it found, so storage is answered rather than assumed', () => {
      // `storage` is the schema a hosted platform would add. This tree creates
      // none, so the honest answer is that there is nothing to deny here, not
      // that a denial was proved.
      expect(proofs.at(-1)?.schemas).toStrictEqual(['ops', 'public']);
      expect(proofs.at(-1)?.schemas).not.toContain('storage');
    });
  });

  describe('the assertions after each prefix', () => {
    it('finds nothing wrong at any prefix', () => {
      const failing = firstFailing(proofs);
      expect(failing === undefined ? '' : describePrefix(failing)).toBe('');
    });
  });

  describe('a live restricted role', () => {
    it('connects, and the server refuses it every table', async () => {
      const outsider = connectAsAdmin(db.restrictedUrl, { source: 'restricted', max: 1 });
      try {
        const who = await outsider.execute<{ readonly name: string }>(
          `select current_user as name`,
        );
        expect(who[0]?.name).toBe(db.restrictedRole);
        await expect(outsider.execute('select * from public.businesses')).rejects.toThrow(
          /permission denied/iu,
        );
        await expect(outsider.execute(`select public.app_business_id()`)).rejects.toThrow(
          /permission denied/iu,
        );
        await expect(
          outsider.execute('create table public.outsider (id uuid primary key)'),
        ).rejects.toThrow(/permission denied/iu);
      } finally {
        await outsider.close();
      }
    });
  });
});

// The harness is only worth running if a prefix can fail it. This is the case
// M02 names: something permissive in the middle, repaired before the end.
describe.skipIf(serverUrl === undefined)('M02: a permissive intermediate prefix', () => {
  let db: EmptyDatabase;
  let proofs: readonly PrefixProof[];

  const opened = syntheticMigration(
    '0002_5_permissive',
    `grant select on public.businesses to public;\n`,
  );
  const repaired = syntheticMigration(
    '0007_5_repair',
    `revoke select on public.businesses from public;\n`,
  );

  beforeAll(async () => {
    db = await createEmptyDatabase({ part: 'q' });
    const spliced = spliceAfter(
      spliceAfter(onDisk, onDisk[1]?.version ?? '', [opened]),
      onDisk.at(-1)?.version ?? '',
      [repaired],
    );
    proofs = await proveEachPrefix(db, spliced);
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('fails at the prefix that opened it', () => {
    const failing = firstFailing(proofs);
    expect(failing?.version).toBe('0002_5_permissive');
    expect(failing?.findings.map((finding) => finding.rule)).toContain(
      'no privilege is granted to PUBLIC, which is every role there will ever be',
    );
    expect(failing?.findings.map((finding) => finding.object)).toContain('public.businesses');
  });

  it('keeps failing at every prefix after it, until the repair', () => {
    const opensAt = proofs.findIndex((proof) => proof.version === '0002_5_permissive');
    const repairsAt = proofs.findIndex((proof) => proof.version === '0007_5_repair');
    expect(opensAt).toBeGreaterThan(0);
    expect(repairsAt).toBe(proofs.length - 1);
    for (const proof of proofs.slice(opensAt, repairsAt)) {
      expect({ version: proof.version, clean: proof.findings.length === 0 }).toStrictEqual({
        version: proof.version,
        clean: false,
      });
    }
  });

  it('is clean at the end, which is exactly why the end is not the proof', () => {
    expect(proofs.at(-1)?.findings).toStrictEqual([]);
    expect(proofs.slice(0, 2).every((proof) => proof.findings.length === 0)).toBe(true);
  });
});
