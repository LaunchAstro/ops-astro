// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried drill that fails before it reads the archive (its scope refused,
// or the archive refused as it is fetched) has no archive id or time to write,
// and its receipt says so with nulls. The operator brings that receipt back
// like any other, so the reader takes it; a receipt that claims anything more
// than an early failure still has to name the archive it read.

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  carried,
  carriedFile,
  drillModule,
  folder,
  gateOf,
  keys,
  noStore,
  scope,
} from './carried-archive.fixture.ts';

const saved = (receipt: unknown): string => {
  const file = join(folder('receipt'), 'receipt.json');
  writeFileSync(file, `${JSON.stringify(receipt)}\n`);
  return file;
};

it('a carried drill refused at its scope leaves a receipt the reader takes back', async () => {
  const { file } = await carriedFile();
  const operator = randomUUID();
  const { drillAsOperator } = await drillModule();
  const receipt = await drillAsOperator({
    gate: gateOf(operator),
    archiveFile: file,
    privateKey: keys.privateKey,
    scope: { ...scope, person: 'not-a-person-id' },
    reach: noStore,
  });
  expect(receipt).toMatchObject({ outcome: 'failed', stage: 'scope', archiveId: null });

  const { readCarriedReceipt } = await carried();
  const own = { personId: operator, business: 'made-up' };
  expect(readCarriedReceipt(saved(receipt), own)).toStrictEqual(receipt);
  for (const later of [
    { ...receipt, stage: 'restore' },
    { ...receipt, outcome: 'pending', stage: null },
  ]) {
    expect(() => readCarriedReceipt(saved(later), own)).toThrow(/archive/u);
  }
}, 60_000);
