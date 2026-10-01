// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3e (REV158S2 criteria 4 and 14): Sol's proofs, named by what they prove.
// A carried receipt and the operator's log carry no archive digest; an export
// that fails to write never prints its path; a receipt of another business is
// refused before the store is reached; planted content in a receipt reaches no
// response or log. The export's own proof (criterion 4) runs through the real
// gate in s0-3e-operating-business.test.ts.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TAKEN,
  carried,
  carriedFile,
  drillModule,
  folder,
  gateOf,
  keys,
  noStore,
  scope,
} from './carried-archive.fixture.ts';

describe('S0-3e carried receipt and export hygiene', () => {
  exportHygieneCases1();

  exportHygieneCases2();

  exportHygieneCases3();

  exportHygieneCases4();
});

function exportHygieneCases1() {
  it('a carried receipt and operator log omit the archive fingerprint', async () => {
    const { file } = await carriedFile();
    const digest = (JSON.parse(readFileSync(`${file}.json`, 'utf8')) as { sha256: string }).sha256;
    const gate = gateOf();
    const { drillAsOperator } = await drillModule();
    const receipt = await drillAsOperator({
      gate,
      archiveFile: file,
      privateKey: keys.privateKey,
      scope,
      reach: noStore,
      drill: async (options: { fetchArchive: () => Promise<unknown> }) => {
        await options.fetchArchive();
        return {
          event: 'restore drill',
          at: new Date().toISOString(),
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
      },
    });
    expect(JSON.stringify(receipt)).not.toContain(digest);
    expect(readFileSync(join(gate.records, 'deployments.jsonl'), 'utf8')).not.toContain(digest);
  });
}

function exportHygieneCases2() {
  it('an export write error never prints its archive path', async () => {
    const file = join(folder('export'), 'archive.sealed');
    const { writeCarried } = await carried();
    let message = '';
    try {
      await writeCarried(file, () =>
        Promise.reject(
          Object.assign(new Error(`ENOSPC: no space left on device, open '${file}'`), {
            code: 'ENOSPC',
          }),
        ),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(file);
  });
}

function exportHygieneCases3() {
  it('a carried receipt from another business is refused before store access', async () => {
    const { file } = await carriedFile();
    const gate = gateOf();
    const { drillAsOperator } = await drillModule();
    const receipt = await drillAsOperator({
      gate,
      archiveFile: file,
      privateKey: keys.privateKey,
      scope,
      reach: noStore,
      drill: async (options: { fetchArchive: () => Promise<unknown> }) => {
        await options.fetchArchive();
        return {
          event: 'restore drill',
          at: new Date().toISOString(),
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
      },
    });
    const receiptFile = join(folder('receipt'), 'carried.json');
    writeFileSync(receiptFile, `${JSON.stringify({ ...receipt, business: randomUUID() })}\n`);
    let storeReads = 0;
    const reach = () => {
      storeReads += 1;
      return Promise.resolve(JSON.stringify(new Date().toISOString()));
    };
    const path = '../../scripts/ops/restore-drill.mjs';
    const { recordCarried } = (await import(/* @vite-ignore */ path)) as {
      recordCarried: (options: Record<string, unknown>) => Promise<unknown>;
    };
    await expect(recordCarried({ gate, storeUrl: 'store', receiptFile, reach })).rejects.toThrow();
    expect(storeReads).toBe(0);
  });
}

function exportHygieneCases4() {
  it('planted content in a carried receipt stays out of responses and logs', async () => {
    const operator = randomUUID();
    const gate = gateOf(operator);
    const canary = `planted-secret-${randomUUID()}`;
    const { RECEIPT_FIELDS } = await drillModule();
    const receipt = {
      ...Object.fromEntries(RECEIPT_FIELDS.map((field) => [field, null])),
      action: 'restore drill recorded',
      outcome: 'pending',
      stage: null,
      at: new Date().toISOString(),
      target: canary,
      productionMajor: 17,
      sourceMajor: 17,
      targetMajor: 17,
      archiveTakenAt: TAKEN,
      archiveId: '00000000-0000-4000-8000-000000000001',
      tables: 12,
      readAs: 'ops_astro_app',
      timings: { fetch: 1 },
      lastTestedRestore: null,
      business: 'made-up',
      operator,
      ranOn: 'carried archive',
    };
    const receiptFile = join(folder('receipt'), 'carried.json');
    writeFileSync(receiptFile, `${JSON.stringify(receipt)}\n`);
    const path = '../../scripts/ops/restore-drill.mjs';
    const { recordCarried } = (await import(/* @vite-ignore */ path)) as {
      recordCarried: (options: Record<string, unknown>) => Promise<unknown>;
    };
    const acceptedAt = new Date().toISOString();
    const reach = () => Promise.resolve(JSON.stringify(acceptedAt));
    // Refused, as a receipt of no fixed shape is (ORCH-DECISION 19:31:54Z item 4):
    // the response is the refusal, and the log is read only if it was written.
    let result: unknown;
    try {
      result = await recordCarried({ gate, storeUrl: 'store', receiptFile, reach });
    } catch (error) {
      result = String(error);
    }
    expect(JSON.stringify(result)).not.toContain(canary);
    const log = join(gate.records, 'deployments.jsonl');
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').not.toContain(canary);
  });
}
