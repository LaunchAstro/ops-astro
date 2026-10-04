// SPDX-License-Identifier: AGPL-3.0-only
//
// An export asks the operator gate again before each part's read reaches the
// store, not after the store has handed the part out (D1 security review F3).
// The gate here refuses as a revocation committed at that moment would: once
// the store has logged the header read, before any part. The store must log
// no part read by that operator after it: no `read_part` statement runs once
// the gate has refused, so nothing is handed out, and no archive file is kept.
//
// A revocation part way stops the reads too (D1 security review R1): the gate
// refuses once the store has logged the first part's read, and the store logs
// no later part. Every part is asked for only after the one before it has
// been read, so no part admitted earlier is still waiting to run.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  addArchive,
  asRole,
  BACKUP,
  backupLogin,
  backupStoreHooks,
  hostReach,
  keys,
  operatorLogin,
  PART,
  seal,
  serverUrl,
  store,
} from './backup-identity.fixture.ts';
import { drillModule, gateOf, operator, scratch } from './backup-carried.fixture.ts';

/** The store's logged reads, by anyone: headers (part null) or parts, in order. */
const reads = async (headers: boolean): Promise<number[]> =>
  (
    await store.admin.execute<{ part: number | null }>(
      `select part from backups.receipts where action = 'backup read' and part is ${headers ? '' : 'not '}null order by id`,
    )
  ).map((row) => row.part ?? -1);

const added = async (body: Buffer): Promise<void> => {
  const job = await asRole(backupLogin.url, BACKUP);
  try {
    await addArchive(job, body);
  } finally {
    await job.end();
  }
};

const REVOKED = 'the operator no longer holds operations:manage';

/** `--export` of the newest archive through `stillOperator`: its outcome and whether the file is kept. */
async function exported(
  stillOperator: () => Promise<void>,
): Promise<{ outcome: string; kept: boolean }> {
  const file = join(mkdtempSync(join(scratch, 'held-back-')), 'archive.sealed');
  const { exportArchive } = await drillModule();
  const outcome = await exportArchive({
    gate: { ...gateOf(operator), stillOperator },
    storeUrl: operatorLogin.url,
    file,
    reach: hostReach,
  }).then(
    () => 'exported',
    () => 'stopped',
  );
  return { outcome, kept: existsSync(file) };
}

describe.skipIf(serverUrl === undefined)('export part reads and the gate', () => {
  backupStoreHooks();
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('a part read never reaches the store once the gate refuses', async () => {
    await added((await seal()).sealArchive(Buffer.from('-- made-up archive\n'), keys.publicKey));
    const [headersBefore, partsBefore] = [(await reads(true)).length, (await reads(false)).length];
    let asked = 0;
    // Admitted until the store has logged the header read; refused from then on.
    const stillOperator = async (): Promise<void> => {
      asked += 1;
      if ((await reads(true)).length > headersBefore) throw new Error(REVOKED);
    };
    const run = await exported(stillOperator);
    expect({ ...run, partsRead: (await reads(false)).length - partsBefore }).toEqual({
      outcome: 'stopped',
      partsRead: 0,
      kept: false,
    });
    expect(asked).toBeGreaterThan(1);
  });

  it('a revocation after the first part is read stops the reads: no later part is logged', async () => {
    // Three parts; the store takes the bytes as they are, sealed or not.
    await added(randomBytes(2 * PART + 1));
    const partsBefore = (await reads(false)).length;
    // Admitted until the store has logged the first part's read; refused from then on.
    const stillOperator = async (): Promise<void> => {
      if ((await reads(false)).length > partsBefore) throw new Error(REVOKED);
    };
    const run = await exported(stillOperator);
    expect({ ...run, partsRead: (await reads(false)).slice(partsBefore) }).toEqual({
      outcome: 'stopped',
      partsRead: [0],
      kept: false,
    });
  });
});
