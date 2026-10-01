// SPDX-License-Identifier: AGPL-3.0-only
//
// The live store suite's carried case (staging-backup-reach-live.test.ts;
// REV158K criteria 13 and 14, REV158S3): the carried record through real
// psql. The digest goes as a bound parameter, so a statement the server
// refuses carries none of it into the log; a pass is taken only through the
// store login the installation appointed as the operator.

import { randomBytes } from 'node:crypto';
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
  /** The person the installation appointed with the store login `logins.operator`. */
  operator: string;
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

/** The pending receipt a carried drill of the archive taken at `takenAt` prints. */
function pendingReceipt(
  takenAt: string,
  archiveId: string,
  operator: string,
): Record<string, unknown> {
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
    archiveId,
    tables: 12,
    readAs: 'ops_astro_app',
    timings: { fetch: 1, open: 2, start: 3, restore: 4, check: 5 },
    lastTestedRestore: null,
    business: 'made-up',
    operator,
    ranOn: 'carried archive',
  };
}

/** One backup by the job, through psql. */
async function backedUp(live: Live): Promise<void> {
  const { runBackup } = await importOps<JobModule>('backup.mjs');
  const added = await runBackup({
    dump: () => Promise.resolve(Buffer.from(`PGDMP carried ${randomBytes(4).toString('hex')}`)),
    storeUrl: live.logins['ops_astro_backup'],
    publicKey: live.keys.publicKey,
    reach: live.reach,
    send,
  });
  expect(added).toMatchObject({ outcome: 'recorded' });
}

/**
 * A backup exported by the appointed operator's own login and its receipt
 * brought back through psql: through the restore identity alone it is
 * refused, with no digest in the store log; through the appointed login it
 * is a pass.
 */
export async function carriedThroughPsql(live: Live): Promise<void> {
  await backedUp(live);
  const ops =
    await importOps<Record<string, (o: Record<string, unknown>) => Promise<unknown>>>(
      'restore-drill.mjs',
    );
  const gate = {
    ok: true,
    operator: { personId: live.operator, business: 'made-up' },
    records: mkdtempSync(join(live.scratch, 'records-')),
    recordSignIn: () => Promise.resolve(),
    recordTestedRestore: () => Promise.resolve(new Date().toISOString()),
  };
  const appointed = live.logins['operator'] ?? '';
  const file = join(mkdtempSync(join(live.scratch, 'carry-')), 'archive.sealed');
  await ops['exportArchive']?.({ gate, storeUrl: appointed, file, reach: live.reach });
  const held = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as Record<string, string>;
  const receiptFile = join(live.scratch, `receipt-${randomBytes(4).toString('hex')}.json`);
  const receipt = pendingReceipt(held['takenAt'] ?? '', held['archiveId'] ?? '', live.operator);
  writeFileSync(receiptFile, `${JSON.stringify(receipt)}\n`);
  const record = (storeUrl: string) =>
    ops['recordCarried']?.({ gate, storeUrl, receiptFile, archiveFile: file, reach: live.reach });
  await expect(record(live.logins['ops_astro_backup_restore'] ?? '')).rejects.toThrow(
    /did not take the receipt/u,
  );
  const logged = live.storeLog();
  expect(logged).toMatch(/ERROR/u);
  expect(logged).not.toContain(held['sha256'] ?? '');
  await expect(record(appointed)).resolves.toMatchObject({ outcome: 'passed' });
  expect(
    live.asAdmin(
      "select count(*) from backups.drills where ran_on = 'carried archive' and outcome = 'passed'",
    ).out,
  ).toBe('1');
}
