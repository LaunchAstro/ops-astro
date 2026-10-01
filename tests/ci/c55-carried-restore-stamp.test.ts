// SPDX-License-Identifier: AGPL-3.0-only
// C55 last tested restore on the carried leg: only --record of a pass the store took stamps.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  TAKEN,
  carriedFile,
  drillModule,
  folder,
  gateOf,
  keys,
  noStore,
  scope,
} from './carried-archive.fixture.ts';

const RESULT = {
  target: 'throwaway container',
  productionMajor: 17,
  sourceMajor: 17,
  targetMajor: 17,
  archiveTakenAt: TAKEN,
  tables: 12,
  readAs: 'ops_astro_app',
  timings: { fetch: 1 },
};

/** The store took the receipt and answers the date of the last passed drill. */
const storeTookIt = () => Promise.resolve(JSON.stringify(new Date().toISOString()));

async function carriedThenRecorded(
  outcome: 'passed' | 'failed',
): Promise<{ onDrill: number; onRecord: number }> {
  const { file } = await carriedFile();
  const personId = crypto.randomUUID();
  let stamps = 0;
  const counting = () => ({
    ...gateOf(personId),
    recordTestedRestore: () => {
      stamps += 1;
      return Promise.resolve(new Date().toISOString());
    },
  });
  const { drillAsOperator, recordCarried } = await drillModule();
  const receipt = await drillAsOperator({
    gate: counting(),
    archiveFile: file,
    privateKey: keys.privateKey,
    scope,
    drill: async (options: { fetchArchive: () => Promise<unknown> }) => {
      await options.fetchArchive();
      return {
        event: 'restore drill',
        at: new Date().toISOString(),
        outcome,
        stage: outcome === 'passed' ? null : 'restore',
        ...RESULT,
      };
    },
    reach: noStore,
  });
  const onDrill = stamps;
  const receiptFile = join(folder('receipt'), 'receipt.json');
  writeFileSync(receiptFile, JSON.stringify(receipt));
  await recordCarried({
    gate: counting(),
    storeUrl: 'store',
    receiptFile,
    archiveFile: file,
    reach: storeTookIt,
  });
  return { onDrill, onRecord: stamps - onDrill };
}

it('C55 last tested restore: a carried pass the store took on --record stamps the date once, and the carried drill itself none', async () => {
  expect(await carriedThenRecorded('passed')).toStrictEqual({ onDrill: 0, onRecord: 1 });
});

it('C55 last tested restore: a carried failure recorded with --record stamps nothing, though the store answers a date', async () => {
  expect(await carriedThenRecorded('failed')).toStrictEqual({ onDrill: 0, onRecord: 0 });
});
