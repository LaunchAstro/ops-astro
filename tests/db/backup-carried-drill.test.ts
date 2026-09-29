// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3e: the carried archive's round trip through the real store (the clean-host
// leg, recovery contract D-3). The export reads the newest backup as the restore
// identity, so the store logs the read; the carried drill's receipt, brought
// back with the archive it restored, is recorded against that read, on the
// archive's own id, by `backups.record_carried_drill`: once, for the operator
// who ran it in the business it ran in, only for the digest of the file carried
// back and, for a pass, only with the restore challenge a restore of that
// archive reads back. Here the challenge is the one the test's archive was
// completed with, kept beside the file as the drill keeps it; that a real
// restore reads it back from the restored database is
// tests/ci/restore-drill.test.ts's carried case. The file side is
// tests/ci/carried-archive.test.ts and tests/ci/carried-receipt.test.ts.
//
// S0-3 (S0-3e). The shared fixture is backup-identity.fixture.ts.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  serverUrl,
  BACKUP,
  RETENTION,
  RESTORE,
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
type DrillModule = { exportArchive: Act; recordCarried: Act };
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

/** `--record`, as the person `personId`, of `receiptFile`, with the archive `archiveFile`. */
const record = async (
  personId: string,
  receiptFile: string,
  archiveFile: string = exported,
): Promise<Receipt> =>
  await (
    await drillModule()
  ).recordCarried({
    gate: gateOf(personId),
    storeUrl: restoreLogin.url,
    receiptFile,
    archiveFile,
    reach: hostReach,
  });

/** The pending receipt a carried drill prints for the archive taken at `takenAt`. */
const pendingReceipt = (takenAt: string): Receipt => ({
  action: 'restore drill recorded',
  ...passed,
  outcome: 'pending',
  at: new Date().toISOString(),
  archiveTakenAt: takenAt,
  lastTestedRestore: null,
  business: 'made-up',
  operator,
  ranOn: 'carried archive',
});

/** Both files of the carried archive `file`, copied to a folder of their own. */
const copied = (file: string): string => {
  const copy = join(mkdtempSync(join(scratch, 'copy-')), 'archive.sealed');
  copyFileSync(file, copy);
  copyFileSync(`${file}.json`, `${copy}.json`);
  return copy;
};

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

let receipt: Receipt;
let exported: string;

/**
 * A new sealed backup in the store, completed with its restore challenge's
 * sha256 as the job completes one, exported; beside the export, the challenge
 * as a drill that restored it keeps it. Answers the receipt that drill prints.
 */
async function carriedReceipt(): Promise<Receipt> {
  const body = (await seal()).sealArchive(Buffer.from('-- a made-up dump\n'), keys.publicKey);
  const challenge = randomBytes(32).toString('hex');
  const job = await asRole(backupLogin.url, BACKUP);
  try {
    await addArchive(job, body, false, sha(challenge));
  } finally {
    await job.end();
  }
  const file = join(mkdtempSync(join(scratch, 'carry-')), 'archive.sealed');
  exported = file;
  await (
    await drillModule()
  ).exportArchive({ gate: gateOf(operator), storeUrl: restoreLogin.url, file, reach: hostReach });
  writeFileSync(`${file}.challenge`, `${challenge}\n`, { mode: 0o600 });
  const takenAt = (JSON.parse(readFileSync(`${file}.json`, 'utf8')) as { takenAt: string }).takenAt;
  return pendingReceipt(takenAt);
}

describe.skipIf(serverUrl === undefined)('the backup store', () => {
  backupStoreHooks();
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  describe('S0-3 carried archive', () => {
    beforeAll(async () => {
      receipt = await carriedReceipt();
    }, 120_000);
    refusedCases();
    challengeCases();
    roundTripCases();
    concurrentCases();
  });
});

/**
 * The exported file with its sealed backup swapped: another dump sealed to the
 * same (public) backup key, its own digest, the real time and id, and the real
 * challenge beside it.
 */
async function swapped(): Promise<string> {
  const { sealArchive } = await seal();
  const { digestOf } = (await import(
    /* @vite-ignore */
    '../../scripts/ops/carried-archive.mjs' as string
  )) as { digestOf: (body: Buffer) => string };
  const held = JSON.parse(readFileSync(`${exported}.json`, 'utf8')) as Record<string, unknown>;
  const body = sealArchive(Buffer.from('-- another dump\n'), keys.publicKey);
  const file = join(mkdtempSync(join(scratch, 'swap-')), 'archive.sealed');
  writeFileSync(file, body);
  writeFileSync(
    `${file}.json`,
    `${JSON.stringify({ ...held, sha256: digestOf(body), bytes: body.length })}\n`,
  );
  copyFileSync(`${exported}.challenge`, `${file}.challenge`);
  return file;
}

function refusedCases() {
  it('a swapped archive, re-sealed to the backup key with its own digest, the real time, id and challenge, is refused at --record and writes nothing', async () => {
    await expect(record(operator, carriedBack(receipt), await swapped())).rejects.toThrow(
      /^(?!.*(?:postgres|s0-3e-)).*$/u,
    );
    expect(await drills()).toStrictEqual([]);
  });

  it('the export is a read the store logs, as the restore identity, the header and each part', async () => {
    const reads = await store.admin.execute<{ action: string; actor: string; part: number | null }>(
      "select action, actor, part from backups.receipts where action = 'backup read' order by id",
    );
    expect([...reads]).toStrictEqual([
      { action: 'backup read', actor: restoreLogin.name, part: null },
      { action: 'backup read', actor: restoreLogin.name, part: 0 },
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

function challengeCases() {
  it('a pending receipt with its archive but no restore challenge is refused, and the store records nothing', async () => {
    await expect(record(operator, carriedBack(receipt), copied(exported))).rejects.toThrow(
      /no restore challenge/u,
    );
    expect(await drills()).toStrictEqual([]);
  });

  it('a pending receipt with a restore challenge that is not the one the job wrote is refused by the store', async () => {
    const copy = copied(exported);
    writeFileSync(`${copy}.challenge`, `${randomBytes(32).toString('hex')}\n`);
    await expect(record(operator, carriedBack(receipt), copy)).rejects.toThrow(
      /did not take the receipt/u,
    );
    expect(await drills()).toStrictEqual([]);
  });

  it('a read of one of two archives taken in one transaction never attests the other, even with its own digest and challenge', async () => {
    const before = (await drills()).length;
    const { sealArchive } = await seal();
    const challenges = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
    const bodies = ['-- one\n', '-- two\n'].map((dump) =>
      sealArchive(Buffer.from(dump), keys.publicKey),
    );
    const job = await asRole(backupLogin.url, BACKUP);
    try {
      await job.query('begin');
      for (const [i, body] of bodies.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- one archive after the other, in one transaction
        await addArchive(job, body, true, sha(challenges[i] ?? ''));
      }
      await job.query('commit');
    } finally {
      await job.end();
    }
    const reader = await asRole(restoreLogin.url, RESTORE);
    try {
      const { rows } = await reader.query<{ id: string; taken_at: Date }>(
        'select id::text, taken_at from backups.read_latest()',
      );
      const [read] = rows;
      const [unread] = [
        ...(await store.admin.execute<{ id: string; sha256: string }>(
          `select id::text, sha256 from backups.archives where id <> '${read?.id}'
             and taken_at = (select taken_at from backups.archives where id = '${read?.id}')`,
        )),
      ];
      expect(unread).toBeDefined();
      const index = bodies.findIndex((body) => sha(body) === unread?.sha256);
      // The other archive: its own digest and the challenge its dump carried.
      expect(index).toBeGreaterThanOrEqual(0);
      const call =
        'select backups.record_carried_drill($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)';
      const args = ['passed', null, operator, read?.taken_at, 17, 17, 17, 12, { fetch: 1 }];
      const attempted = [...args, unread?.sha256, challenges[index], unread?.id];
      expect(await attempt(reader, call, attempted)).toBe('42501');
    } finally {
      await reader.end();
    }
    expect(await drills()).toHaveLength(before);
  });
}

function roundTripCases() {
  it('the round trip: with the archive and the challenge its restore reads back, the receipt is recorded once as a carried drill, echoes none of it, and dates the last tested restore', async () => {
    const challenge = readFileSync(`${exported}.challenge`, 'utf8');
    const recorded = await record(operator, carriedBack(receipt));
    expect(Object.keys(recorded).toSorted()).toStrictEqual(
      ['action', 'at', 'business', 'lastTestedRestore', 'operator', 'outcome', 'ranOn'].toSorted(),
    );
    expect(recorded).toMatchObject({ outcome: 'passed', ranOn: 'carried archive', operator });
    expect(typeof recorded['lastTestedRestore']).toBe('string');
    expect(await drills()).toStrictEqual([{ outcome: 'passed', ran_on: 'carried archive' }]);
    // A replay of the same receipt, challenge and all, never records a second drill.
    writeFileSync(`${exported}.challenge`, challenge);
    await expect(record(operator, carriedBack(receipt))).rejects.toThrow();
    expect(await drills()).toStrictEqual([{ outcome: 'passed', ran_on: 'carried archive' }]);
  });

  it('only the restore identity records a carried drill', async () => {
    const at = receipt['archiveTakenAt'];
    const held = JSON.parse(readFileSync(`${exported}.json`, 'utf8')) as Record<string, string>;
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
      'ab'.repeat(32),
      held['archiveId'],
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

  it('exporting an archive without a clean-host restore cannot record a passed drill', async () => {
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
      archiveDigest: held.sha256,
    };
    await expect(record(operator, carriedBack(fabricated))).rejects.toThrow();
    expect(await drills()).toHaveLength(before);
  });
}
