// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3e: the carried archive's round trip through the real store (the clean-host
// leg, recovery contract D-3). The export reads the newest backup as the restore
// identity, so the store logs the read; the carried drill's receipt, brought
// back, is recorded against that read by `backups.record_carried_drill`, once,
// for the operator who ran it, and names where it ran. The file side is
// tests/ci/carried-archive.test.ts and tests/ci/carried-receipt.test.ts.
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
  addArchive,
  backupStoreHooks,
  hostReach,
  seal,
} from './backup-identity.fixture.ts';
import { passed } from './backup-drill-records.fixture.ts';

type Receipt = Record<string, unknown>;
type Act = (options: Record<string, unknown>) => Promise<Receipt>;
type DrillModule = { drillAsOperator: Act; exportArchive: Act; recordCarried: Act };
const drillModule = async (): Promise<DrillModule> => {
  const path = '../../scripts/ops/restore-drill.mjs';
  return (await import(
    /* @vite-ignore */
    path
  )) as DrillModule;
};

const scratch = mkdtempSync(join(tmpdir(), 's0-3e-db-'));
const operator = randomUUID();
const gateOf = (personId: string): Receipt => ({
  ok: true,
  operator: { personId, business: 'made-up' },
  records: mkdtempSync(join(scratch, 'records-')),
  recordSignIn: () => Promise.resolve(),
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

/** `--record`, as the person `personId`, of the receipt file `receiptFile`. */
const record = async (personId: string, receiptFile: string): Promise<Receipt> =>
  await (
    await drillModule()
  ).recordCarried({
    gate: gateOf(personId),
    storeUrl: restoreLogin.url,
    receiptFile,
    reach: hostReach,
  });

let receipt: Receipt;
let exported: string;

/** A new sealed backup in the store, exported, and drilled on the carried file. */
async function carriedReceipt(): Promise<Receipt> {
  const body = (await seal()).sealArchive(Buffer.from('-- a made-up dump\n'), keys.publicKey);
  const job = await asRole(backupLogin.url, BACKUP);
  try {
    await addArchive(job, body);
  } finally {
    await job.end();
  }
  const { exportArchive, drillAsOperator } = await drillModule();
  const file = join(mkdtempSync(join(scratch, 'carry-')), 'archive.sealed');
  exported = file;
  const gate = gateOf(operator);
  await exportArchive({ gate, storeUrl: restoreLogin.url, file, reach: hostReach });
  const takenAt = (JSON.parse(readFileSync(`${file}.json`, 'utf8')) as { takenAt: string }).takenAt;
  const at = new Date().toISOString();
  return await drillAsOperator({
    gate,
    archiveFile: file,
    privateKey: keys.privateKey,
    scope: { business: randomUUID(), client: randomUUID(), person: randomUUID() },
    drill: async (options: { fetchArchive: () => Promise<unknown> }) => {
      await options.fetchArchive();
      return { event: 'restore drill', at, ...passed, archiveTakenAt: takenAt };
    },
  });
}

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

/**
 * The exported file with its sealed backup swapped: another dump sealed to the
 * same (public) backup key, its own digest, and the real time; then drilled.
 */
async function swappedAndDrilled(): Promise<Receipt> {
  const { sealArchive } = await seal();
  const { digestOf } = (await import(
    /* @vite-ignore */
    '../../scripts/ops/carried-archive.mjs' as string
  )) as { digestOf: (body: Buffer) => string };
  const held = JSON.parse(readFileSync(`${exported}.json`, 'utf8')) as Record<string, unknown>;
  const body = sealArchive(Buffer.from('-- another dump\n'), keys.publicKey);
  const file = join(mkdtempSync(join(scratch, 'swap-')), 'archive.sealed');
  const swapped = { ...held, sha256: digestOf(body), bytes: body.length };
  writeFileSync(file, body);
  writeFileSync(`${file}.json`, `${JSON.stringify(swapped)}\n`);
  const at = new Date().toISOString();
  return await (
    await drillModule()
  ).drillAsOperator({
    gate: gateOf(operator),
    archiveFile: file,
    privateKey: keys.privateKey,
    scope: { business: randomUUID(), client: randomUUID(), person: randomUUID() },
    drill: async (options: { fetchArchive: () => Promise<{ takenAt: string }> }) => {
      const archive = await options.fetchArchive();
      return { event: 'restore drill', at, ...passed, archiveTakenAt: archive.takenAt };
    },
  });
}

function refusedCases() {
  it('a swapped archive, re-sealed to the backup key with its own digest and the real time, is refused at --record and writes nothing', async () => {
    const swapped = await swappedAndDrilled();
    expect(swapped['archiveTakenAt']).toBe(receipt['archiveTakenAt']);
    await expect(record(operator, carriedBack(swapped))).rejects.toThrow(
      /^(?!.*(?:postgres|s0-3e-)).*$/u,
    );
    expect(await drills()).toStrictEqual([]);
  });

  it('the export is a read the store logs, as the restore identity', async () => {
    const reads = await store.admin.execute<{ action: string; actor: string }>(
      "select action, actor from backups.receipts where action = 'backup read'",
    );
    expect([...reads]).toStrictEqual([{ action: 'backup read', actor: restoreLogin.name }]);
  });

  it('a receipt brought back by another person is refused, and the store records nothing', async () => {
    await expect(record(randomUUID(), carriedBack(receipt))).rejects.toThrow();
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
  it('the round trip: brought back, the receipt is recorded once as a carried drill and dates the last tested restore', async () => {
    const recorded = await record(operator, carriedBack(receipt));
    expect(recorded).toMatchObject({ outcome: 'passed', ranOn: 'carried archive', operator });
    expect(typeof recorded['lastTestedRestore']).toBe('string');
    expect(await drills()).toStrictEqual([{ outcome: 'passed', ran_on: 'carried archive' }]);
    // A replay of the same receipt never records a second drill.
    await expect(record(operator, carriedBack(receipt))).rejects.toThrow();
    expect(await drills()).toStrictEqual([{ outcome: 'passed', ran_on: 'carried archive' }]);
  });

  it('only the restore identity records a carried drill', async () => {
    const at = receipt['archiveTakenAt'];
    const digest = receipt['archiveDigest'];
    const args = ['passed', null, operator, at, 17, 17, 17, 12, { fetch: 1 }, digest];
    const call = 'select backups.record_carried_drill($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)';
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

function concurrentCases() {
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
