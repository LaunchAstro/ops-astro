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

import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
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
    const held = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as { sha256: string };
    expect(receipt).toMatchObject({
      outcome: 'pending',
      ranOn: 'carried archive',
      lastTestedRestore: null,
      operator,
    });
    const kept = readFileSync(join(gate.records, 'deployments.jsonl'), 'utf8').trim().split('\n');
    expect(kept.map((line) => JSON.parse(line) as Receipt)).toStrictEqual([receipt]);
    // Criterion 14: the digest is in neither the printed receipt nor its log.
    expect(`${JSON.stringify(receipt)}${kept.join('')}`).not.toContain(held.sha256);
    // The kept line is what --record takes back on the machine that runs staging.
    const own = { personId: operator, business: 'made-up' };
    expect((await carried()).readCarriedReceipt(saved(`${kept[0]}\n`), own)).toStrictEqual(receipt);
  });

  it('the restore challenge a drill read back is kept beside the archive, mode 600, and never printed or logged', async () => {
    const { file } = await carriedFile();
    const gate = gateOf();
    const challenge = randomBytes(32).toString('hex');
    const { drillAsOperator } = await drillModule();
    const receipt = await drillAsOperator({
      gate,
      archiveFile: file,
      privateKey: keys.privateKey,
      scope,
      drill: async (options: { fetchArchive: () => Promise<unknown> }) => {
        await options.fetchArchive();
        const result = { event: 'restore drill', at: new Date().toISOString(), ...PASSED };
        // As restoreDrill keeps it: off the record's own fields.
        return Object.defineProperty(result, 'challenge', { value: challenge, enumerable: false });
      },
      reach: noStore,
    });
    expect(receipt['outcome']).toBe('pending');
    expect(readFileSync(`${file}.challenge`, 'utf8')).toBe(`${challenge}\n`);
    expect(statSync(`${file}.challenge`).mode & 0o777).toBe(0o600);
    const log = readFileSync(join(gate.records, 'deployments.jsonl'), 'utf8');
    expect(`${JSON.stringify(receipt)}${log}`).not.toContain(challenge);
    expect((await carried()).readChallenge(file)).toBe(challenge);
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
      action: 'restore drill recorded',
      at: TAKEN,
      business: 'made-up',
      operator,
      ranOn: 'carried archive',
    };
    const { readCarriedReceipt } = await carried();
    const own = { personId: operator, business: 'made-up' };
    expect(readCarriedReceipt(saved(JSON.stringify(good)), own)).toStrictEqual(good);
    const hostile: Record<string, string> = {
      'another person': JSON.stringify({ ...good, operator: randomUUID() }),
      'another business': JSON.stringify({ ...good, business: 'another-business' }),
      'a target of its own': JSON.stringify({ ...good, target: CANARY }),
      'a stage of its own': JSON.stringify({ ...good, stage: CANARY }),
      'a reader of its own': JSON.stringify({ ...good, readAs: CANARY }),
      'timings of its own': JSON.stringify({ ...good, timings: { [CANARY]: 1 } }),
      'a timing that is not a count': JSON.stringify({ ...good, timings: { fetch: CANARY } }),
      'a business that is not text': JSON.stringify({ ...good, business: { key: CANARY } }),
      'a drill that ran on staging': JSON.stringify({ ...good, ranOn: 'staging machine' }),
      'a receipt already recorded': JSON.stringify({ ...good, lastTestedRestore: TAKEN }),
      'another action': JSON.stringify({ ...good, action: 'archive exported' }),
      'an extra field': JSON.stringify({ ...good, note: CANARY }),
      'a missing field': JSON.stringify({ ...good, tables: undefined }),
      'a prototype key': `{"__proto__":{"outcome":"passed"},${JSON.stringify(good).slice(1)}`,
      'a major that is not a number': JSON.stringify({ ...good, sourceMajor: '17' }),
      'an outcome of its own': JSON.stringify({ ...good, outcome: 'maybe' }),
      'a pass the store never checked': JSON.stringify({ ...good, outcome: 'passed' }),
      'a digest carried in it': JSON.stringify({ ...good, archiveDigest: 'ab'.repeat(32) }),
      'two receipts': `${JSON.stringify(good)}\n${JSON.stringify(good)}`,
      'not JSON': 'passed',
    };
    for (const [what, text] of Object.entries(hostile)) {
      expect(() => readCarriedReceipt(saved(text), own), what).toThrow(NAMES_NOTHING);
    }
  });
}
