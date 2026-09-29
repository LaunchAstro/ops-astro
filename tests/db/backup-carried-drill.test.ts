// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3e: the carried archive's round trip through the real store (the clean-host
// leg, recovery contract D-3). The export reads the newest backup as the restore
// identity, so the store logs the read; the carried drill's receipt, brought
// back, is recorded against that read by `backups.record_carried_drill`, once,
// for the operator who ran it, and names where it ran. The file side is
// tests/ci/carried-archive.test.ts.
//
// S0-3 (S0-3e). The shared fixture is backup-identity.fixture.ts.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  backupStoreHooks,
  hostReach,
  seal,
} from './backup-identity.fixture.ts';
import { passed } from './backup-drill-records.fixture.ts';

type Receipt = Record<string, unknown>;
type DrillModule = {
  drillAsOperator: (options: Record<string, unknown>) => Promise<Receipt>;
  exportArchive: (options: Record<string, unknown>) => Promise<Receipt>;
  recordCarried: (options: Record<string, unknown>) => Promise<Receipt>;
};
const drillModule = async (): Promise<DrillModule> => {
  const path = '../../scripts/ops/restore-drill.mjs';
  return (await import(/* @vite-ignore */ path)) as DrillModule;
};

const scratch = mkdtempSync(join(tmpdir(), 's0-3e-db-'));
const operator = randomUUID();
const gateOf = (personId: string): Receipt => ({
  ok: true,
  operator: { personId, business: 'made-up' },
  records: mkdtempSync(join(scratch, 'records-')),
  recordSignIn: async () => {},
});

const drills = async (): Promise<{ outcome: string; ran_on: string }[]> => [
  ...(await store.admin.execute<{ outcome: string; ran_on: string }>(
    'select outcome, ran_on from backups.drills order by id',
  )),
];

/** The receipt a carried drill printed, saved as the operator carries it back. */
const carriedBack = (receipt: Receipt, change: Receipt = {}): string => {
  const file = join(mkdtempSync(join(scratch, 'back-')), 'receipt.json');
  writeFileSync(file, `${JSON.stringify({ ...receipt, ...change })}\n`);
  return file;
};

describe.skipIf(serverUrl === undefined)('the backup store', () => {
  backupStoreHooks();
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  describe('S0-3 carried archive', () => {
    let receipt: Receipt;

    beforeAll(async () => {
      const body = (await seal()).sealArchive(Buffer.from('-- a made-up dump\n'), keys.publicKey);
      const job = await asRole(backupLogin.url, BACKUP);
      try {
        await job.query('insert into backups.archives (body) values ($1)', [body]);
      } finally {
        await job.end();
      }
      const { exportArchive, drillAsOperator } = await drillModule();
      const file = join(mkdtempSync(join(scratch, 'carry-')), 'archive.sealed');
      await exportArchive({
        gate: gateOf(operator),
        storeUrl: restoreLogin.url,
        file,
        reach: hostReach,
      });
      const takenAt = (JSON.parse(readFileSync(file, 'utf8')) as { takenAt: string }).takenAt;
      receipt = await drillAsOperator({
        gate: gateOf(operator),
        archiveFile: file,
        privateKey: keys.privateKey,
        scope: { business: randomUUID(), client: randomUUID(), person: randomUUID() },
        drill: async () => ({
          event: 'restore drill',
          at: new Date().toISOString(),
          ...passed,
          archiveTakenAt: takenAt,
        }),
      });
    }, 120_000);

    it('the export is a read the store logs, as the restore identity', async () => {
      const reads = await store.admin.execute<{ action: string; actor: string }>(
        "select action, actor from backups.receipts where action = 'backup read'",
      );
      expect([...reads]).toStrictEqual([{ action: 'backup read', actor: restoreLogin.name }]);
    });

    it('a receipt brought back by another person is refused, and the store records nothing', async () => {
      const { recordCarried } = await drillModule();
      await expect(
        recordCarried({
          gate: gateOf(randomUUID()),
          storeUrl: restoreLogin.url,
          receiptFile: carriedBack(receipt),
          reach: hostReach,
        }),
      ).rejects.toThrow();
      expect(await drills()).toStrictEqual([]);
    });

    it('a receipt for an archive the store never handed out is refused', async () => {
      const { recordCarried } = await drillModule();
      const other = new Date(
        Date.parse(receipt['archiveTakenAt'] as string) - 60_000,
      ).toISOString();
      await expect(
        recordCarried({
          gate: gateOf(operator),
          storeUrl: restoreLogin.url,
          receiptFile: carriedBack(receipt, { archiveTakenAt: other }),
          reach: hostReach,
        }),
      ).rejects.toThrow(/^(?!.*(?:postgres|s0-3e-)).*$/u);
      expect(await drills()).toStrictEqual([]);
    });

    it('the round trip: brought back, the receipt is recorded once as a carried drill and dates the last tested restore', async () => {
      const { recordCarried } = await drillModule();
      const recorded = await recordCarried({
        gate: gateOf(operator),
        storeUrl: restoreLogin.url,
        receiptFile: carriedBack(receipt),
        reach: hostReach,
      });
      expect(recorded).toMatchObject({ outcome: 'passed', ranOn: 'carried archive', operator });
      expect(typeof recorded['lastTestedRestore']).toBe('string');
      expect(await drills()).toStrictEqual([{ outcome: 'passed', ran_on: 'carried archive' }]);
      // A replay of the same receipt never records a second drill.
      await expect(
        recordCarried({
          gate: gateOf(operator),
          storeUrl: restoreLogin.url,
          receiptFile: carriedBack(receipt),
          reach: hostReach,
        }),
      ).rejects.toThrow();
      expect(await drills()).toStrictEqual([{ outcome: 'passed', ran_on: 'carried archive' }]);
    });

    it('only the restore identity records a carried drill', async () => {
      const args = [
        receipt['outcome'],
        null,
        operator,
        receipt['archiveTakenAt'],
        17,
        17,
        17,
        12,
        { fetch: 1 },
      ];
      const call = 'select backups.record_carried_drill($1, $2, $3, $4, $5, $6, $7, $8, $9)';
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
  });
});
