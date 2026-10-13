// SPDX-License-Identifier: AGPL-3.0-only
//
// The trace export's tick (`exportDeployment` in `apps/api/trace-exporter.ts`)
// gives every business its turn, however the businesses before it fail. It
// meets A first, whose transaction fails on every tick, and B is still reached
// on every tick. It goes red if the tick returns on the first business that
// fails. No database: a stand-in pool fails A's transactions and records B's.

import { describe, expect, it, vi } from 'vitest';
import { exportDeployment } from '../../apps/api/trace-exporter.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';

const A = '11111111-1111-4111-8111-111111111111' as BusinessId;
const B = '22222222-2222-4222-8222-222222222222' as BusinessId;

/** A pool whose transactions fail for A and answer nothing for anyone else, each recorded. */
function failingFirst() {
  const reached: string[] = [];
  const database = {
    withBusiness: async <T>(businessId: string): Promise<T> => {
      reached.push(businessId);
      if (businessId === A) throw new Error('A rolled back');
      return await Promise.resolve([] as T);
    },
  };
  return { database, reached };
}

describe('the trace export tick', () => {
  it('reaches a later business on every tick while the first fails every time', async () => {
    const { database, reached } = failingFirst();
    const deliver = vi.fn();
    for (let tick = 0; tick < 2; tick += 1) {
      // eslint-disable-next-line no-await-in-loop -- one tick after another, as the interval runs them
      await expect(
        exportDeployment(
          database,
          async () => await Promise.resolve([A, B]),
          Buffer.alloc(32),
          deliver,
        ),
        'the tick still reports the failure',
      ).rejects.toThrow('A rolled back');
    }
    expect(reached.filter((id) => id === A)).toHaveLength(2);
    expect(reached.filter((id) => id === B).length, 'B never had its turn').toBeGreaterThanOrEqual(
      2,
    );
  });
});
