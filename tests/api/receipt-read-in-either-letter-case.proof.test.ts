// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import {
  appliedWith,
  asPerson,
  linking,
  noDatabase,
  useReceiptWorld,
} from './aw-08-receipt-world.ts';

useReceiptWorld('sol1397receipt');
it.skipIf(noDatabase)(
  'uppercase UUIDs return the same observed receipt',
  async () => {
    const { receipt } = await appliedWith(linking(null));
    const attemptId = receipt['attemptId'];
    if (typeof attemptId !== 'string') throw new Error('The observed receipt has no attempt id');
    expect(attemptId.toUpperCase()).not.toBe(attemptId);
    const lower = await asPerson('task.receipt', { attemptId });
    expect(lower.status).toBe(200);
    const upper = await asPerson('task.receipt', { attemptId: attemptId.toUpperCase() });
    expect(upper.status).toBe(200);
    expect(upper.body).toStrictEqual(lower.body);
  },
  60_000,
);
