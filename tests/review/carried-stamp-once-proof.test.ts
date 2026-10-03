// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  backupStoreHooks,
  hostReach,
  operatorLogin,
  serverUrl,
} from '../db/backup-identity.fixture.ts';
import {
  carriedBack,
  carriedReceipt,
  drillModule,
  exportedFile,
  gateOf,
  operator,
  scratch,
} from '../db/backup-carried.fixture.ts';

describe.skipIf(serverUrl === undefined)('OW-063 carried stamp retry', () => {
  backupStoreHooks();
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('concurrent retries of one accepted carried receipt stamp at most once', async () => {
    const receipt = await carriedReceipt();
    const receiptFile = carriedBack(receipt);
    const archiveFile = exportedFile();
    const { recordCarried } = await drillModule();
    const common = { storeUrl: operatorLogin.url, receiptFile, archiveFile, reach: hostReach };
    // A real store acceptance followed by an unavailable operations stamp
    // produces the recovery note by the production path itself.
    await expect(
      recordCarried({
        ...common,
        gate: { ...gateOf(operator), recordTestedRestore: () => Promise.reject(new Error('down')) },
      }),
    ).rejects.toThrow(/re-run --record/u);
    expect(JSON.parse(readFileSync(`${receiptFile}.stamp-owed`, 'utf8'))).toMatchObject({
      archiveId: receipt['archiveId'],
    });
    let stamps = 0;
    const gate = {
      ...gateOf(operator),
      recordTestedRestore: () => {
        stamps += 1;
        return Promise.resolve(new Date().toISOString());
      },
    };
    const outcomes = await Promise.allSettled([
      recordCarried({ ...common, gate }),
      recordCarried({ ...common, gate }),
    ]);
    expect(stamps, JSON.stringify(outcomes.map((r) => r.status))).toBe(1);
  });
});
