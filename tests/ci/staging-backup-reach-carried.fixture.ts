// SPDX-License-Identifier: AGPL-3.0-only
//
// The live store suite's carried case (staging-backup-reach-live.test.ts;
// REV158K criteria 13 and 14): the carried record through real psql. The
// digest and the challenge go as bound parameters, so a statement the server
// refuses and logs carries neither; the challenge the job wrote makes the pass.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';

type Reach = (
  url: string,
  script: string | Iterable<string> | AsyncIterable<string>,
  onLine?: (line: string) => unknown,
) => Promise<string>;
type Live = {
  reach: Reach;
  logins: Record<string, string>;
  keys: { publicKey: string; privateKey: string };
  asAdmin: (script: string) => { status: number | null; out: string };
  scratch: string;
  /** What the store's server has logged so far. */
  storeLog: () => string;
};
type JobModule = { runBackup: (o: Record<string, unknown>) => Promise<Record<string, unknown>> };

const importOps = async <T>(name: string): Promise<T> => {
  const path = `../../scripts/ops/${name}`;
  return (await import(
    /* @vite-ignore */
    path
  )) as T;
};
const send = (): Promise<string> => Promise.resolve('sent');

/** A backup with its challenge, exported, then recorded through psql: refused, then passed. */
/** The pending receipt a carried drill of the archive taken at `takenAt` prints. */
function pendingReceipt(takenAt: string, operator: string): Record<string, unknown> {
  return {
    action: 'restore drill recorded',
    outcome: 'pending',
    stage: null,
    at: new Date().toISOString(),
    target: 'throwaway container',
    productionMajor: 17,
    sourceMajor: 17,
    targetMajor: 17,
    archiveTakenAt: takenAt,
    tables: 12,
    readAs: 'ops_astro_app',
    timings: { fetch: 1, open: 2, start: 3, restore: 4, check: 5 },
    lastTestedRestore: null,
    business: 'made-up',
    operator,
    ranOn: 'carried archive',
  };
}

/** One backup by the job, its restore challenge written first: answers the challenge. */
async function backedUp(live: Live): Promise<string> {
  const { runBackup } = await importOps<JobModule>('backup.mjs');
  let written = '';
  const added = await runBackup({
    challenge: (challenge: string) => {
      written = challenge;
      return Promise.resolve();
    },
    dump: () => Promise.resolve(Buffer.from(`PGDMP carried ${randomBytes(4).toString('hex')}`)),
    storeUrl: live.logins['ops_astro_backup'],
    publicKey: live.keys.publicKey,
    reach: live.reach,
    send,
  });
  expect(added).toMatchObject({ outcome: 'recorded' });
  return written;
}

export async function carriedThroughPsql(live: Live): Promise<void> {
  const written = await backedUp(live);
  const ops =
    await importOps<Record<string, (o: Record<string, unknown>) => Promise<unknown>>>(
      'restore-drill.mjs',
    );
  const operator = randomUUID();
  const gate = {
    ok: true,
    operator: { personId: operator, business: 'made-up' },
    records: mkdtempSync(join(live.scratch, 'records-')),
    recordSignIn: () => Promise.resolve(),
  };
  const storeUrl = live.logins['ops_astro_backup_restore'];
  const file = join(mkdtempSync(join(live.scratch, 'carry-')), 'archive.sealed');
  await ops['exportArchive']?.({ gate, storeUrl, file, reach: live.reach });
  const held = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as Record<string, string>;
  const receiptFile = join(live.scratch, `receipt-${randomBytes(4).toString('hex')}.json`);
  const receipt = pendingReceipt(held['takenAt'] ?? '', operator);
  writeFileSync(receiptFile, `${JSON.stringify(receipt)}\n`);
  const wrong = randomBytes(32).toString('hex');
  writeFileSync(`${file}.challenge`, `${wrong}\n`);
  const record = () =>
    ops['recordCarried']?.({ gate, storeUrl, receiptFile, archiveFile: file, reach: live.reach });
  await expect(record()).rejects.toThrow(/did not take the receipt/u);
  const logged = live.storeLog();
  expect(logged).toMatch(/ERROR/u);
  for (const secret of [wrong, held['sha256'] ?? '', written]) expect(logged).not.toContain(secret);
  writeFileSync(`${file}.challenge`, `${written}\n`);
  await expect(record()).resolves.toMatchObject({ outcome: 'passed' });
  expect(
    live.asAdmin(
      "select count(*) from backups.drills where ran_on = 'carried archive' and outcome = 'passed'",
    ).out,
  ).toBe('1');
}
