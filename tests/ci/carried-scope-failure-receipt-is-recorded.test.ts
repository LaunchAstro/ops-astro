// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
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
} from './carried-archive.fixture.ts';

it('the record command accepts the scope-failure receipt its carried drill emits', async () => {
  const { file: archiveFile } = await carriedFile();
  const gate = gateOf(randomUUID());
  const { drillAsOperator, recordCarried } = await drillModule();
  const receipt = await drillAsOperator({
    gate,
    archiveFile,
    privateKey: keys.privateKey,
    scope: { ...scope, person: 'not-a-person-id' },
    reach: noStore,
  });
  expect(receipt).toMatchObject({ outcome: 'failed', stage: 'scope', archiveId: null });
  const receiptFile = join(folder('scope-failure'), 'receipt.json');
  writeFileSync(receiptFile, `${JSON.stringify(receipt)}\n`);
  const calls: string[] = [];
  await expect(
    recordCarried({
      gate,
      storeUrl: 'postgres://synthetic.invalid/store',
      receiptFile,
      archiveFile,
      reach: (_url: string, sql: string) => {
        calls.push(sql);
        return Promise.resolve('');
      },
    }),
  ).resolves.toMatchObject({ action: 'carried drill recorded', outcome: 'failed' });
  expect(calls).toHaveLength(1);
}, 60_000);
