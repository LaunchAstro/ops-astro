// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { receiptLinkOf } from '../../packages/core-runtime/src/receipt-link.ts';
import {
  asPerson,
  attempts,
  HOST,
  launched,
  linking,
  useReceiptWorld,
  workerOn,
} from './aw-08-receipt-world.ts';

useReceiptWorld('solow014secret');

it('a provider receipt on the declared host must not persist or return an agent delegation credential in its path', async () => {
  const { taskId, credential } = await launched();
  const link = `https://${HOST}/effects/${credential}`;
  // A safe link on the same host remains a positive control when this defect is fixed.
  const safe = `https://${HOST}/effects/sol-proof`;
  expect(receiptLinkOf(safe, 'synthetic_comment')).toBe(safe);
  expect(link.length <= 512).toBe(true);
  const outcome = await workerOn(credential, linking(link)).applyOnce(taskId);
  if (!('applied' in outcome)) throw new Error('the synthetic effect did not apply');
  const answer = await asPerson('task.receipt', { attemptId: outcome.applied.attemptId });
  expect(answer.status).toBe(200);
  const receipt = answer.body['receipt'];
  expect(receipt).toMatchObject({ settlement: { state: 'settled' } });
  const stored = await attempts(taskId);
  expect(stored[0]?.['observed']).toBe(true);
  // Compare booleans to keep the actual credential out of failure output.
  expect(
    [JSON.stringify(receipt), JSON.stringify(stored)].map((value) => value.includes(credential)),
    'no credential may be copied into the stored link or the person receipt response',
  ).toEqual([false, false]);
});
