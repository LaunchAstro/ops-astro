// SPDX-License-Identifier: AGPL-3.0-only
//
// An export asks the operator gate again before each part's read reaches the
// store, not after the store has handed the part out (D1 security review F3).
// The gate here admits the header read and the parts call, then refuses, as a
// revocation committed at that moment would. The store must log no part read
// by that operator after it: no `read_part` statement runs once the gate has
// refused, so nothing is handed out, and no archive file is kept.

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
  seal,
  serverUrl,
  store,
} from './backup-identity.fixture.ts';
import { drillModule, gateOf, operator, scratch } from './backup-carried.fixture.ts';

/** Part reads the store has logged, by anyone. */
const partReads = async (): Promise<number> =>
  (
    await store.admin.execute<{ n: number }>(
      "select count(*)::int as n from backups.receipts where action = 'backup read' and part is not null",
    )
  )[0]?.n ?? -1;

describe.skipIf(serverUrl === undefined)('export part reads and the gate', () => {
  backupStoreHooks();
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('a part read never reaches the store once the gate refuses', async () => {
    const body = (await seal()).sealArchive(Buffer.from('-- made-up archive\n'), keys.publicKey);
    const job = await asRole(backupLogin.url, BACKUP);
    try {
      await addArchive(job, body);
    } finally {
      await job.end();
    }
    let asked = 0;
    const gate = {
      ...gateOf(operator),
      // The header read and the parts call are admitted; every later ask is refused.
      stillOperator: (): Promise<void> => {
        asked += 1;
        return asked > 2
          ? Promise.reject(new Error('the operator no longer holds operations:manage'))
          : Promise.resolve();
      },
    };
    const before = await partReads();
    const file = join(mkdtempSync(join(scratch, 'held-back-')), 'archive.sealed');
    const { exportArchive } = await drillModule();
    const outcome = await exportArchive({
      gate,
      storeUrl: operatorLogin.url,
      file,
      reach: hostReach,
    }).then(
      () => 'exported',
      () => 'stopped',
    );
    expect({ outcome, partsRead: (await partReads()) - before, kept: existsSync(file) }).toEqual({
      outcome: 'stopped',
      partsRead: 0,
      kept: false,
    });
    expect(asked).toBeGreaterThan(2);
  });
});
