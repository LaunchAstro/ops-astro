// SPDX-License-Identifier: AGPL-3.0-only
//
// The S0-3e carried-archive DB suites' shared parts (backup-carried-drill.test.ts,
// backup-carried-attest.test.ts): the drill's module, an admitted gate, the
// store's drills, a receipt carried back, --record, and a new backup exported
// by the appointed operator's own store login.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll } from 'vitest';
import {
  BACKUP,
  keys,
  asRole,
  store,
  backupLogin,
  operatorLogin,
  OPERATING_BUSINESS,
  addArchive,
  hostReach,
  seal,
} from './backup-identity.fixture.ts';
import { operator, passed } from './backup-drill-records.fixture.ts';

export type Receipt = Record<string, unknown>;
export type Act = (options: Record<string, unknown>) => Promise<Receipt>;
export type DrillModule = { exportArchive: Act; recordCarried: Act };
/** The store id of the first archive exported at each time, as a drill of it names it. */
const exportedAt = new Map<string, string>();
export const drillModule = async (): Promise<DrillModule> => {
  const path = '../../scripts/ops/restore-drill.mjs';
  const module = (await import(
    /* @vite-ignore */
    path
  )) as DrillModule;
  return {
    ...module,
    exportArchive: async (options) => {
      const done = await module.exportArchive(options);
      const facts = JSON.parse(readFileSync(`${String(options['file'])}.json`, 'utf8')) as {
        takenAt: string;
        archiveId: string;
      };
      if (!exportedAt.has(facts.takenAt)) exportedAt.set(facts.takenAt, facts.archiveId);
      return done;
    },
  };
};

// Made by the file's first hook, so a file whose tests all skip leaves no folder (temp guard).
export const scratch: string = join(tmpdir(), `s0-3e-db-${randomBytes(6).toString('hex')}`);
beforeAll(() => mkdirSync(scratch, { mode: 0o700 }));
export { operator };
export const gateOf = (personId: string): Receipt => ({
  ok: true,
  operator: { personId, business: OPERATING_BUSINESS },
  records: mkdtempSync(join(scratch, 'records-')),
  recordSignIn: () => Promise.resolve(),
  recordTestedRestore: () => Promise.resolve(new Date().toISOString()),
});

export const drills = async (): Promise<{ outcome: string; ran_on: string }[]> => [
  ...(await store.admin.execute<{ outcome: string; ran_on: string }>(
    'select outcome, ran_on from backups.drills order by id',
  )),
];

/** The receipt a carried drill printed, saved as the operator carries it back. */
export const carriedBack = (receipt: Receipt, change: Receipt = {}): string => {
  const file = join(mkdtempSync(join(scratch, 'back-')), 'receipt.json');
  writeFileSync(file, `${JSON.stringify({ ...receipt, ...change })}\n`);
  return file;
};

/**
 * `--record`, as the person `personId`, of `receiptFile`, with the archive
 * `archiveFile`, through the store login `storeUrl` (the appointed
 * operator's own, unless a case says otherwise).
 */
export const record = async (
  personId: string,
  receiptFile: string,
  archiveFile: string = exported,
  storeUrl: string = operatorLogin.url,
): Promise<Receipt> =>
  await (
    await drillModule()
  ).recordCarried({
    gate: gateOf(personId),
    storeUrl,
    receiptFile,
    archiveFile,
    reach: hostReach,
  });

/**
 * The pending receipt a carried drill prints for the archive taken at
 * `takenAt`: by default the first one exported at that time, by its store id.
 */
export const pendingReceipt = (
  takenAt: string,
  archiveId: string = exportedAt.get(takenAt) ?? '',
): Receipt => ({
  action: 'restore drill recorded',
  ...passed,
  outcome: 'pending',
  at: new Date().toISOString(),
  archiveTakenAt: takenAt,
  archiveId,
  lastTestedRestore: null,
  business: OPERATING_BUSINESS,
  operator,
  ranOn: 'carried archive',
});

/** Both files of the carried archive `file`, copied to a folder of their own. */
export const copied = (file: string): string => {
  const copy = join(mkdtempSync(join(scratch, 'copy-')), 'archive.sealed');
  copyFileSync(file, copy);
  copyFileSync(`${file}.json`, `${copy}.json`);
  return copy;
};

export const sha = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

let exported = '';

/** The carried archive the last `carriedReceipt` exported. */
export const exportedFile = (): string => exported;

/**
 * A new sealed backup in the store, exported by the appointed operator's own
 * store login, as `--export` on the machine. Answers the receipt a drill that
 * restored it prints.
 */
export async function carriedReceipt(): Promise<Receipt> {
  const body = (await seal()).sealArchive(Buffer.from('-- a made-up dump\n'), keys.publicKey);
  const job = await asRole(backupLogin.url, BACKUP);
  try {
    await addArchive(job, body);
  } finally {
    await job.end();
  }
  const file = join(mkdtempSync(join(scratch, 'carry-')), 'archive.sealed');
  exported = file;
  await (
    await drillModule()
  ).exportArchive({ gate: gateOf(operator), storeUrl: operatorLogin.url, file, reach: hostReach });
  const takenAt = (JSON.parse(readFileSync(`${file}.json`, 'utf8')) as { takenAt: string }).takenAt;
  return pendingReceipt(takenAt);
}

/**
 * The exported file with its sealed backup swapped: another dump sealed to the
 * same (public) backup key, its own digest, and the real time and id.
 */
export async function swapped(): Promise<string> {
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
  return file;
}
