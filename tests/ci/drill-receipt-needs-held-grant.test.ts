// SPDX-License-Identifier: AGPL-3.0-only
//
// The drill writes its receipt and its stamp only under the operator's held
// grant, asked again under the hold (drill-acts.mjs, `attested`). A gate that
// cannot hold the grant or ask again is refused before the store is reached,
// with no fallback; and a refusal under the hold writes nothing, the stamp a
// re-run of --record owes included.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  carriedFile,
  drillModule,
  folder,
  gateOf,
  keys,
  noStore,
  scope,
  TAKEN,
} from './carried-archive.fixture.ts';

const RESULT = {
  event: 'restore drill',
  at: TAKEN,
  outcome: 'passed',
  stage: null,
  target: 'throwaway container',
  productionMajor: 17,
  sourceMajor: 17,
  targetMajor: 17,
  archiveTakenAt: TAKEN,
  tables: 12,
  readAs: 'ops_astro_app',
  timings: { fetch: 1 },
};

/** A gate double counting its stamps, its record lines and the store's calls, less `without`. */
function counted(without: string, personId?: string) {
  const counts = { store: 0, stamps: 0 };
  const gate: Record<string, unknown> = {
    ...gateOf(personId),
    recordTestedRestore: () => {
      counts.stamps += 1;
      return Promise.resolve(new Date().toISOString());
    },
  };
  delete gate[without];
  const reach = () => {
    counts.store += 1;
    return Promise.resolve(JSON.stringify(new Date().toISOString()));
  };
  return { counts, gate, reach };
}

/** A carried pass, drilled and its receipt written, ready for --record. */
async function carriedPass(personId: string): Promise<{ file: string; receiptFile: string }> {
  const { file } = await carriedFile();
  const { drillAsOperator } = await drillModule();
  const receipt = await drillAsOperator({
    gate: gateOf(personId),
    archiveFile: file,
    privateKey: keys.privateKey,
    scope,
    drill: async (options: { fetchArchive: () => Promise<unknown> }) => {
      await options.fetchArchive();
      return RESULT;
    },
    reach: noStore,
  });
  const receiptFile = join(folder('receipt'), 'receipt.json');
  writeFileSync(receiptFile, JSON.stringify(receipt));
  return { file, receiptFile };
}

it.each(['holdingGrant', 'stillOperator'])(
  'a drill on the machine with a gate lacking %s is refused before the store, and stamps nothing',
  async (without) => {
    const { counts, gate, reach } = counted(without);
    const { drillAsOperator } = await drillModule();
    const run = drillAsOperator({
      gate,
      storeUrl: 'store',
      privateKey: keys.privateKey,
      scope,
      reach,
      drill: () => Promise.resolve(RESULT),
    });
    await expect(run).rejects.toThrow(/holdingGrant and stillOperator/u);
    expect(counts).toStrictEqual({ store: 0, stamps: 0 });
  },
);

it.each(['holdingGrant', 'stillOperator'])(
  '--record with a gate lacking %s is refused before the store, and stamps nothing',
  async (without) => {
    const personId = crypto.randomUUID();
    const { file, receiptFile } = await carriedPass(personId);
    const { counts, gate, reach } = counted(without, personId);
    const { recordCarried } = await drillModule();
    const run = recordCarried({ gate, storeUrl: 'store', receiptFile, archiveFile: file, reach });
    await expect(run).rejects.toThrow(/holdingGrant and stillOperator/u);
    expect(counts).toStrictEqual({ store: 0, stamps: 0 });
  },
);

it('a re-run of --record that owes only the stamp writes none once the operator no longer holds the grant', async () => {
  const personId = crypto.randomUUID();
  const { file, receiptFile } = await carriedPass(personId);
  const { recordCarried } = await drillModule();
  // The store takes the pass; the stamp fails, so the re-run owes it.
  await expect(
    recordCarried({
      gate: { ...gateOf(personId), recordTestedRestore: () => Promise.reject(new Error('down')) },
      storeUrl: 'store',
      receiptFile,
      archiveFile: file,
      reach: () => Promise.resolve(JSON.stringify(new Date().toISOString())),
    }),
  ).rejects.toThrow(/re-run --record/u);
  const { counts, gate } = counted('none', personId);
  const refused = recordCarried({
    gate: {
      ...gate,
      stillOperator: () => Promise.reject(new Error('the operator no longer holds it')),
    },
    storeUrl: 'store',
    receiptFile,
    archiveFile: file,
    reach: noStore,
  });
  await expect(refused).rejects.toThrow(
    /the drill ran, but the operator no longer holds operations:manage, so no receipt was written/u,
  );
  expect(counts.stamps).toBe(0);
});
