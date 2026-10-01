// SPDX-License-Identifier: AGPL-3.0-only
// C55 last tested restore on the carried leg: only --record of a pass the store took stamps.
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

it('C55 last tested restore: a stamp that failed after the store took a carried pass is written by a re-run of --record, without the store again', async () => {
  const { file } = await carriedFile();
  const personId = crypto.randomUUID();
  const { drillAsOperator, recordCarried } = await drillModule();
  const receipt = await drillAsOperator({
    gate: gateOf(personId),
    archiveFile: file,
    privateKey: keys.privateKey,
    scope,
    drill: async (options: { fetchArchive: () => Promise<unknown> }) => {
      await options.fetchArchive();
      return { event: 'restore drill', at: TAKEN, outcome: 'passed', stage: null, ...RESULT };
    },
    reach: noStore,
  });
  const receiptFile = join(folder('receipt'), 'receipt.json');
  writeFileSync(receiptFile, JSON.stringify(receipt));
  let [storeCalls, stamps] = [0, 0];
  // The store takes a receipt once; a replay is refused (drills_carried_once).
  const storeOnce = () =>
    (storeCalls += 1) === 1 ? storeTookIt() : Promise.reject(new Error('refused'));
  const record = (stamp: () => Promise<string>) =>
    recordCarried({
      gate: { ...gateOf(personId), recordTestedRestore: stamp },
      storeUrl: 'store',
      receiptFile,
      archiveFile: file,
      reach: storeOnce,
    });
  await expect(record(() => Promise.reject(new Error('down')))).rejects.toThrow(/re-run --record/u);
  const retried = await record(() => {
    stamps += 1;
    return Promise.resolve(new Date().toISOString());
  });
  expect({ storeCalls, stamps, outcome: retried['outcome'] }).toStrictEqual({
    storeCalls: 1,
    stamps: 1,
    outcome: 'passed',
  });
});

/** A carried pass, drilled and its receipt written, ready for --record. */
async function carriedPass(): Promise<{
  file: string;
  personId: string;
  receiptFile: string;
  recordCarried: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
}> {
  const { file } = await carriedFile();
  const personId = crypto.randomUUID();
  const { drillAsOperator, recordCarried } = await drillModule();
  const receipt = await drillAsOperator({
    gate: gateOf(personId),
    archiveFile: file,
    privateKey: keys.privateKey,
    scope,
    drill: async (options: { fetchArchive: () => Promise<unknown> }) => {
      await options.fetchArchive();
      return { event: 'restore drill', at: TAKEN, outcome: 'passed', stage: null, ...RESULT };
    },
    reach: noStore,
  });
  const receiptFile = join(folder('receipt'), 'receipt.json');
  writeFileSync(receiptFile, JSON.stringify(receipt));
  return { file, personId, receiptFile, recordCarried };
}

const STAMPED = '2026-09-30 01:02:03.456789+00';

it('C55 last tested restore: --record of a carried pass records the date the stamp wrote, not the store answer or a note', async () => {
  const pass = await carriedPass();
  const record = async (stamp: () => Promise<string>, reach: () => Promise<string>) =>
    await pass.recordCarried({
      gate: { ...gateOf(pass.personId), recordTestedRestore: stamp },
      storeUrl: 'store',
      receiptFile: pass.receiptFile,
      archiveFile: pass.file,
      reach,
    });
  const first = await record(() => Promise.resolve(STAMPED), storeTookIt);
  expect(first['lastTestedRestore']).toBe(STAMPED);
  // A note left by a failed stamp names a date of its own; the record carries the stamp's.
  const again = await carriedPass();
  await expect(
    again.recordCarried({
      gate: {
        ...gateOf(again.personId),
        recordTestedRestore: () => Promise.reject(new Error('down')),
      },
      storeUrl: 'store',
      receiptFile: again.receiptFile,
      archiveFile: again.file,
      reach: storeTookIt,
    }),
  ).rejects.toThrow(/re-run --record/u);
  const retried = await again.recordCarried({
    gate: { ...gateOf(again.personId), recordTestedRestore: () => Promise.resolve(STAMPED) },
    storeUrl: 'store',
    receiptFile: again.receiptFile,
    archiveFile: again.file,
    reach: () => Promise.reject(new Error('refused')),
  });
  expect(retried['lastTestedRestore']).toBe(STAMPED);
});

it.each(['not json', JSON.stringify({ archiveId: 7 }), '[]'])(
  'C55 last tested restore: a malformed stamp-owed note is named plainly, with no stamp (%s)',
  async (note) => {
    const pass = await carriedPass();
    let stamps = 0;
    const gate = {
      ...gateOf(pass.personId),
      recordTestedRestore: () => {
        stamps += 1;
        return Promise.resolve(STAMPED);
      },
    };
    writeFileSync(`${pass.receiptFile}.stamp-owed`, note);
    await expect(
      pass.recordCarried({
        gate,
        storeUrl: 'store',
        receiptFile: pass.receiptFile,
        archiveFile: pass.file,
        reach: noStore,
      }),
    ).rejects.toThrow(/stamp-owed note .* is not one --record wrote/u);
    expect(stamps).toBe(0);
  },
);

it('C55 last tested restore: a carried pass is stamped with no note when the receipt folder cannot be written', async () => {
  const pass = await carriedPass();
  let stamps = 0;
  chmodSync(dirname(pass.receiptFile), 0o500);
  try {
    const recorded = await pass.recordCarried({
      gate: {
        ...gateOf(pass.personId),
        recordTestedRestore: () => {
          stamps += 1;
          return Promise.resolve(STAMPED);
        },
      },
      storeUrl: 'store',
      receiptFile: pass.receiptFile,
      archiveFile: pass.file,
      reach: storeTookIt,
    });
    expect({ stamps, outcome: recorded['outcome'] }).toStrictEqual({
      stamps: 1,
      outcome: 'passed',
    });
    expect(existsSync(`${pass.receiptFile}.stamp-owed`)).toBe(false);
  } finally {
    chmodSync(dirname(pass.receiptFile), 0o700);
  }
});

it('C55 last tested restore: a failed stamp whose note cannot be written either tells the operator both', async () => {
  const pass = await carriedPass();
  chmodSync(dirname(pass.receiptFile), 0o500);
  try {
    const failing = pass.recordCarried({
      gate: {
        ...gateOf(pass.personId),
        recordTestedRestore: () => Promise.reject(new Error('down')),
      },
      storeUrl: 'store',
      receiptFile: pass.receiptFile,
      archiveFile: pass.file,
      reach: storeTookIt,
    });
    await expect(failing).rejects.toThrow(
      /could not be written for the operations view.*the note to finish it.*could not be written either/su,
    );
  } finally {
    chmodSync(dirname(pass.receiptFile), 0o700);
  }
});
