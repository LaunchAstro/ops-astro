// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 revert timed (case 8): the revert is published forward, observed
// served, and its interval recorded only once the original word is live.

import { describe, expect, it } from 'vitest';
import {
  revertCorrection,
  type CorrectionTarget,
} from '../../packages/core-connectors/src/index.ts';

const TARGET: CorrectionTarget = {
  path: 'src/pages/throwaway.astro',
  word: 'alongside',
  replacement: 'beside',
};

describe('C80 revert timed', () => {
  it('publishes the revert forward, observes it served, and records the interval from the decision to revert', async () => {
    const times = [Date.parse('2026-09-29T10:00:00Z'), Date.parse('2026-09-29T10:03:30Z')];
    const outcome = await revertCorrection(
      { publishedRevision: 'def456', target: TARGET, seam: 'revert-of-def456' },
      {
        now: () => times.shift() ?? Number.NaN,
        revert: () =>
          Promise.resolve({ kind: 'ok', value: { revision: 'rev789', deploymentId: 'dpl_2' } }),
        readDeployment: () =>
          Promise.resolve({ kind: 'ok', value: { revision: 'rev789', served: true } }),
        capture: () => Promise.resolve({ ok: true, value: { text: 'We walk alongside you.' } }),
      },
    );
    expect(outcome).toEqual({
      state: 'reverted',
      revision: 'rev789',
      deploymentId: 'dpl_2',
      decidedAt: '2026-09-29T10:00:00.000Z',
      observedAt: '2026-09-29T10:03:30.000Z',
      intervalMs: 210_000,
    });
  });

  it('records no interval until the original word is observed live', async () => {
    const outcome = await revertCorrection(
      { publishedRevision: 'def456', target: TARGET, seam: 'revert-of-def456' },
      {
        now: () => Date.parse('2026-09-29T10:00:00Z'),
        revert: () =>
          Promise.resolve({ kind: 'ok', value: { revision: 'rev789', deploymentId: 'dpl_2' } }),
        readDeployment: () =>
          Promise.resolve({ kind: 'ok', value: { revision: 'rev789', served: true } }),
        capture: () => Promise.resolve({ ok: true, value: { text: 'We walk beside you.' } }),
      },
    );
    expect(outcome).toMatchObject({ state: 'revert_accepted' });
    expect(outcome).not.toHaveProperty('intervalMs');
  });
});
