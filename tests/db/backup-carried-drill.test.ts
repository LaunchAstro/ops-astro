// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3e: the carried archive's round trip through the real store (the clean-host
// leg, recovery contract D-3). The export reads the newest backup as the restore
// identity, so the store logs the read; the carried drill's receipt, brought
// back with the archive it restored, is recorded against that read, on the
// archive's own id, by `backups.record_carried_drill`: once, for the operator
// who ran it in the business it ran in, only for the digest of the file carried
// back, and a pass only through the store login the installation appointed as
// that operator (backup-carried-attest.test.ts). Here the export and the record
// run through that login. The file side is tests/ci/carried-archive.test.ts and
// tests/ci/carried-receipt.test.ts.
//
// S0-3 (S0-3e). The shared fixture is backup-identity.fixture.ts.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  serverUrl,
  BACKUP,
  RETENTION,
  keys,
  asRole,
  attempt,
  store,
  backupLogin,
  retentionLogin,
  restoreLogin,
  operatorLogin,
  OPERATING_BUSINESS,
  addArchive,
  backupStoreHooks,
  hostReach,
  seal,
} from './backup-identity.fixture.ts';
import {
  carriedBack,
  carriedReceipt,
  drillModule,
  drills,
  exportedFile,
  gateOf,
  operator,
  record,
  scratch,
  swapped,
  type Receipt,
} from './backup-carried.fixture.ts';

let receipt: Receipt;

describe.skipIf(serverUrl === undefined)('the backup store', () => {
  backupStoreHooks();
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  describe('S0-3 carried archive', () => {
    beforeAll(async () => {
      receipt = await carriedReceipt();
    }, 120_000);
    refusedCases();
    roundTripCases();
    concurrentCases();
  });
});

function refusedCases() {
  it('a swapped archive, re-sealed to the backup key with its own digest, the real time and id, is refused at --record and writes nothing', async () => {
    await expect(record(operator, carriedBack(receipt), await swapped())).rejects.toThrow(
      /^(?!.*(?:postgres|s0-3e-)).*$/u,
    );
    expect(await drills()).toStrictEqual([]);
  });

  it("the export is a read the store logs, as the operator's own restore login, the header and each part", async () => {
    const reads = await store.admin.execute<{ action: string; actor: string; part: number | null }>(
      "select action, actor, part from backups.receipts where action = 'backup read' order by id",
    );
    expect([...reads]).toStrictEqual([
      { action: 'backup read', actor: operatorLogin.name, part: null },
      { action: 'backup read', actor: operatorLogin.name, part: 0 },
    ]);
  });

  it('a receipt brought back by another person is refused, and the store records nothing', async () => {
    await expect(record(randomUUID(), carriedBack(receipt))).rejects.toThrow();
    expect(await drills()).toStrictEqual([]);
  });

  it('a receipt of another business is refused before the store, and the store records nothing', async () => {
    await expect(
      record(operator, carriedBack(receipt, { business: 'another-business' })),
    ).rejects.toThrow(/another person or business/u);
    expect(await drills()).toStrictEqual([]);
  });

  it('a receipt for an archive the store never handed out is refused', async () => {
    const other = new Date(Date.parse(receipt['archiveTakenAt'] as string) - 60_000).toISOString();
    await expect(record(operator, carriedBack(receipt, { archiveTakenAt: other }))).rejects.toThrow(
      /^(?!.*(?:postgres|s0-3e-)).*$/u,
    );
    expect(await drills()).toStrictEqual([]);
  });
}

function roundTripCases() {
  roundTripCases1();

  roundTripCases2();
}

function concurrentCases() {
  concurrentCases1();

  concurrentCases2();
}

function concurrentCases1() {
  it('two records of one receipt at once: the store takes one and refuses the other', async () => {
    const before = (await drills()).length;
    const second = await carriedReceipt();
    const both = await Promise.allSettled([
      record(operator, carriedBack(second)),
      record(operator, carriedBack(second)),
    ]);
    expect(both.map((result) => result.status).toSorted()).toStrictEqual(['fulfilled', 'rejected']);
    expect(await drills()).toHaveLength(before + 1);
  });
}

// REV854 criterion 13's proof, adapted to the trust model (ORCH-DECISION
// 22:06Z): with no restore challenge, what refuses a pass that no restore
// stands behind is that only the appointed operator's own act records one.
// The fabricated receipt now has the exact accepted shape and names the
// archive it exported, so the store is what refuses it.
function concurrentCases2() {
  it('exporting an archive without a clean-host restore cannot record a passed drill through a login the installation did not appoint', async () => {
    const before = (await drills()).length;
    const body = (await seal()).sealArchive(Buffer.from('-- a made-up dump\n'), keys.publicKey);
    const job = await asRole(backupLogin.url, BACKUP);
    try {
      await addArchive(job, body);
    } finally {
      await job.end();
    }
    const file = join(mkdtempSync(join(scratch, 'sol-export-')), 'archive.sealed');
    await (
      await drillModule()
    ).exportArchive({
      gate: gateOf(operator),
      storeUrl: restoreLogin.url,
      file,
      reach: hostReach,
    });
    const held = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as {
      takenAt: string;
      sha256: string;
    };
    const fabricated: Receipt = {
      action: 'restore drill recorded',
      outcome: 'pending',
      stage: null,
      at: new Date().toISOString(),
      target: 'throwaway container',
      productionMajor: 17,
      sourceMajor: 17,
      targetMajor: 17,
      archiveTakenAt: held.takenAt,
      tables: 12,
      readAs: 'ops_astro_app',
      timings: { fetch: 1, open: 1, start: 1, restore: 1, check: 1 },
      lastTestedRestore: null,
      business: 'made-up',
      operator,
      ranOn: 'carried archive',
    };
    await expect(record(operator, carriedBack(fabricated), file, restoreLogin.url)).rejects.toThrow(
      /not the installation's appointed operator/u,
    );
    expect(await drills()).toHaveLength(before);
  });
}

function roundTripCases1() {
  it("the round trip: with the archive it restored, the appointed operator's receipt is recorded once as a carried drill, echoes none of it, and dates the last tested restore", async () => {
    const recorded = await record(operator, carriedBack(receipt));
    expect(Object.keys(recorded).toSorted()).toStrictEqual(
      ['action', 'at', 'business', 'lastTestedRestore', 'operator', 'outcome', 'ranOn'].toSorted(),
    );
    expect(recorded).toMatchObject({ outcome: 'passed', ranOn: 'carried archive', operator });
    expect(typeof recorded['lastTestedRestore']).toBe('string');
    expect(await drills()).toStrictEqual([{ outcome: 'passed', ran_on: 'carried archive' }]);
    // A replay of the same receipt never records a second drill.
    await expect(record(operator, carriedBack(receipt))).rejects.toThrow();
    expect(await drills()).toStrictEqual([{ outcome: 'passed', ran_on: 'carried archive' }]);
  });
}

function roundTripCases2() {
  it('only the restore identity records a carried drill', async () => {
    const at = receipt['archiveTakenAt'];
    const held = JSON.parse(readFileSync(`${exportedFile()}.json`, 'utf8')) as Record<
      string,
      string
    >;
    const args = [
      'passed',
      null,
      operator,
      at,
      17,
      17,
      17,
      12,
      { fetch: 1 },
      held['sha256'],
      held['archiveId'],
      OPERATING_BUSINESS,
    ];
    const call =
      'select backups.record_carried_drill($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)';
    for (const [url, role] of [
      [backupLogin.url, BACKUP],
      [retentionLogin.url, RETENTION],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const client = await asRole(url, role);
      try {
        // oxlint-disable-next-line no-await-in-loop
        expect(await attempt(client, call, args), role).toBe('42501');
      } finally {
        // oxlint-disable-next-line no-await-in-loop
        await client.end();
      }
    }
  });
}
