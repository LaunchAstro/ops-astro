// SPDX-License-Identifier: AGPL-3.0-only
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
  refusing,
  scope,
} from '../ci/carried-archive.fixture.ts';

it('an emitted carried scope-failure receipt can be read back', async () => {
  const { file } = await carriedFile();
  const personId = randomUUID();
  const gate = gateOf(personId);
  const { drillAsOperator, restoreDrill } = await drillModule();
  const fake = refusing();
  const receipt = await drillAsOperator({
    gate,
    archiveFile: file,
    privateKey: keys.privateKey,
    scope: { ...scope, person: undefined },
    drill: (options: Record<string, unknown>) => restoreDrill({ ...options, docker: fake.docker }),
    reach: noStore,
  });
  expect(receipt).toMatchObject({ outcome: 'failed', stage: 'scope', archiveId: null });
  expect(fake.calls).toEqual([]);
  const saved = join(folder('receipt'), 'receipt.json');
  writeFileSync(saved, JSON.stringify(receipt));
  const { readCarriedReceipt } = await carried();
  expect(() => readCarriedReceipt(saved, { personId, business: 'made-up' })).not.toThrow();
});
