// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3e: the carried drill's receipt (the clean-host leg, recovery contract
// D-3). Off the machine that runs staging the store is out of reach, so the
// drill on a carried archive keeps and prints its receipt, which says where it
// ran and names no last tested restore; `restore-drill.mjs --record` takes it
// back only whole, unrecorded and from the operator who ran it. The store's
// side is tests/db/backup-carried-drill.test.ts; the archive's,
// carried-archive.test.ts.
//
// `S0-3 carried archive`: the receipt round trip on the file side, and hostile
// receipts refused.

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANARY,
  NAMES_NOTHING,
  TAKEN,
  carried,
  carriedFile,
  drillModule,
  folder,
  gateOf,
  keys,
  noStore,
  scope,
  type Receipt,
} from './carried-archive.fixture.ts';

describe('S0-3 carried archive', () => {
  keptCases();
  refusedCases();
});

const PASSED = {
  outcome: 'passed',
  target: 'throwaway container',
  productionMajor: 17,
  sourceMajor: 17,
  targetMajor: 17,
  archiveTakenAt: TAKEN,
  tables: 12,
  readAs: 'ops_astro_app',
  timings: { fetch: 1 },
};

/** `text`, saved as the operator carries a receipt back. */
const saved = (text: string): string => {
  const file = join(folder('receipt'), 'receipt.json');
  writeFileSync(file, text);
  return file;
};

function keptCases() {
  it('the carried receipt is printed and kept, says it ran on a carried archive, and names no last tested restore', async () => {
    const { file } = await carriedFile();
    const operator = randomUUID();
    const gate = gateOf(operator);
    const { drillAsOperator, RECEIPT_FIELDS } = await drillModule();
    const receipt = await drillAsOperator({
      gate,
      archiveFile: file,
      privateKey: keys.privateKey,
      scope,
      drill: async (options: { fetchArchive: () => Promise<unknown> }) => {
        await options.fetchArchive();
        return { event: 'restore drill', at: new Date().toISOString(), ...PASSED };
      },
      reach: noStore,
    });
    expect(Object.keys(receipt).toSorted()).toStrictEqual([...RECEIPT_FIELDS].toSorted());
    // Off the machine it is not a passed drill: the store checks the archive when it is recorded.
    const held = JSON.parse(readFileSync(file, 'utf8')) as { sha256: string };
    expect(receipt).toMatchObject({
      outcome: 'pending',
      ranOn: 'carried archive',
      archiveDigest: held.sha256,
      lastTestedRestore: null,
      operator,
    });
    const kept = readFileSync(join(gate.records, 'deployments.jsonl'), 'utf8').trim().split('\n');
    expect(kept.map((line) => JSON.parse(line) as Receipt)).toStrictEqual([receipt]);
    // The kept line is what --record takes back on the machine that runs staging.
    expect((await carried()).readCarriedReceipt(saved(`${kept[0]}\n`), operator)).toStrictEqual(
      receipt,
    );
  });
}

function refusedCases() {
  it('a carried receipt is refused unless it is one whole carried receipt of the operator who brings it', async () => {
    const operator = randomUUID();
    const { RECEIPT_FIELDS } = await drillModule();
    const good: Receipt = {
      ...Object.fromEntries(RECEIPT_FIELDS.map((field) => [field, null])),
      ...PASSED,
      outcome: 'pending',
      archiveDigest: 'ab'.repeat(32),
      action: 'restore drill recorded',
      at: TAKEN,
      business: 'made-up',
      operator,
      ranOn: 'carried archive',
    };
    const { readCarriedReceipt } = await carried();
    expect(readCarriedReceipt(saved(JSON.stringify(good)), operator)).toStrictEqual(good);
    const hostile: Record<string, string> = {
      'another person': JSON.stringify({ ...good, operator: randomUUID() }),
      'a drill that ran on staging': JSON.stringify({ ...good, ranOn: 'staging machine' }),
      'a receipt already recorded': JSON.stringify({ ...good, lastTestedRestore: TAKEN }),
      'another action': JSON.stringify({ ...good, action: 'archive exported' }),
      'an extra field': JSON.stringify({ ...good, note: CANARY }),
      'a missing field': JSON.stringify({ ...good, tables: undefined }),
      'a prototype key': `{"__proto__":{"outcome":"passed"},${JSON.stringify(good).slice(1)}`,
      'a major that is not a number': JSON.stringify({ ...good, sourceMajor: '17' }),
      'an outcome of its own': JSON.stringify({ ...good, outcome: 'maybe' }),
      'a pass the store never checked': JSON.stringify({ ...good, outcome: 'passed' }),
      'a digest that is not one': JSON.stringify({ ...good, archiveDigest: 'AB'.repeat(32) }),
      'two receipts': `${JSON.stringify(good)}\n${JSON.stringify(good)}`,
      'not JSON': 'passed',
    };
    for (const [what, text] of Object.entries(hostile)) {
      expect(() => readCarriedReceipt(saved(text), operator), what).toThrow(NAMES_NOTHING);
    }
  });
}
