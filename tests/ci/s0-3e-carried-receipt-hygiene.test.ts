// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3e receipt hygiene and binding (REV158K criteria 4 and 14): Sol's proofs,
// named by what they prove. A carried receipt of another business is never
// recorded; a carried drill's receipt and its log carry no archive digest; a
// planted secret in a carried receipt reaches no log or response. The export's
// own proof (criterion 4) runs through the real gate in
// s0-3e-operating-business.test.ts.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANARY,
  TAKEN,
  carriedFile,
  drillModule,
  folder,
  gateOf,
  keys,
  scope,
} from './carried-archive.fixture.ts';

const save = (receipt: Record<string, unknown>): string => {
  const file = join(folder('sol-receipt'), 'receipt.json');
  writeFileSync(file, `${JSON.stringify(receipt)}\n`);
  return file;
};

const pending = (operator: string, business: string): Record<string, unknown> => ({
  action: 'restore drill recorded',
  outcome: 'pending',
  stage: null,
  at: TAKEN,
  target: 'throwaway container',
  productionMajor: 17,
  sourceMajor: 17,
  targetMajor: 17,
  archiveTakenAt: TAKEN,
  tables: 1,
  readAs: 'ops_astro_app',
  timings: { fetch: 1, open: 1, start: 1, restore: 1, check: 1 },
  lastTestedRestore: null,
  business,
  operator,
  ranOn: 'carried archive',
  archiveDigest: 'ab'.repeat(32),
});

describe('S0-3e carried receipt hygiene', () => {
  hygieneCases1();

  hygieneCases2();

  hygieneCases3();
});

function hygieneCases1() {
  it('another business receipt cannot be recorded under this business', async () => {
    const operator = randomUUID();
    const gate = gateOf(operator);
    const receiptFile = save(pending(operator, 'another-business'));
    const { recordCarried } = await drillModule();
    await expect(
      recordCarried({
        gate,
        storeUrl: 'store',
        receiptFile,
        reach: () => Promise.resolve(JSON.stringify(TAKEN)),
      }),
    ).rejects.toThrow();
    expect(readdirSync(gate.records)).toStrictEqual([]);
  });
}

function hygieneCases2() {
  it('a carried drill receipt and its log contain no archive fingerprint', async () => {
    const { file } = await carriedFile();
    const gate = gateOf();
    const held = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as { sha256: string };
    const { drillAsOperator } = await drillModule();
    const receipt = await drillAsOperator({
      gate,
      archiveFile: file,
      privateKey: keys.privateKey,
      scope,
      drill: async (options: { fetchArchive: () => Promise<unknown> }) => {
        await options.fetchArchive();
        return {
          outcome: 'passed',
          stage: null,
          target: 'throwaway container',
          productionMajor: 17,
          sourceMajor: 17,
          targetMajor: 17,
          archiveTakenAt: TAKEN,
          tables: 1,
          readAs: 'ops_astro_app',
          timings: { fetch: 1, open: 1, start: 1, restore: 1, check: 1 },
        };
      },
    });
    expect(JSON.stringify(receipt)).not.toContain(held.sha256);
    expect(readFileSync(join(gate.records, 'deployments.jsonl'), 'utf8')).not.toContain(
      held.sha256,
    );
  });
}

function hygieneCases3() {
  it('a planted secret in a carried receipt never reaches a log or response', async () => {
    const operator = randomUUID();
    const gate = gateOf(operator);
    const receiptFile = save({ ...pending(operator, 'made-up'), target: CANARY });
    const { recordCarried } = await drillModule();
    let output = '';
    try {
      const result = await recordCarried({
        gate,
        storeUrl: 'store',
        receiptFile,
        reach: () => Promise.resolve(JSON.stringify(TAKEN)),
      });
      output = JSON.stringify(result);
    } catch (error) {
      output = String(error);
    }
    if (readdirSync(gate.records).includes('deployments.jsonl')) {
      output += readFileSync(join(gate.records, 'deployments.jsonl'), 'utf8');
    }
    expect(output).not.toContain(CANARY);
  });
}
