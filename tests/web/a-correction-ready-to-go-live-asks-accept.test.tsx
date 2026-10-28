// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// #1988: the second approval of a site change. A correction the locate found,
// waiting for its decision while its check holds, asks "Your change is ready
// to go live. Accept?" with the text before and after, above Launch and
// Decline; one whose check does not hold, whose Launch is held for a missing
// review (#1781), or past its decision, asks nothing.

import { afterEach, describe, expect, it } from 'vitest';
import type { Correction } from '../../apps/web/src/assistant/correction-desks.ts';
import { CorrectionCard } from '../../apps/web/src/views/correction-card.tsx';
import { mount, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

const WAITING: Correction = {
  correctionId: 'c-1',
  ask: { page: 'About', word: 'Brisbane', replacement: 'Townsville' },
  state: 'requested',
  approver: null,
  versionId: 'v-1',
  verifiedForMs: 600_000,
  readAt: performance.now(),
  reason: null,
  refusal: null,
  receipts: null,
  reviewMissingFor: null,
};

const drawn = (correction: Correction) =>
  mount(
    <CorrectionCard
      correction={correction}
      busy={false}
      onDecide={() => {}}
      onReceipts={() => {}}
      onReread={() => {}}
    />,
  );

describe('a correction ready to go live', () => {
  it('asks Accept with the located text before and after, above the decision', async () => {
    const view = await drawn(WAITING);
    const ready = view.find('[data-correction-ready]');
    expect(ready?.textContent).toBe(
      'Your change is ready to go live. Accept?Before: “Brisbane”After: “Townsville”',
    );
    expect(view.all('[data-correction-decide]')).toHaveLength(2);
  });

  it('asks nothing before the version is read, while its check does not hold, or once it is decided', async () => {
    for (const correction of [
      { ...WAITING, versionId: null },
      { ...WAITING, verifiedForMs: 0 },
      { ...WAITING, readAt: null },
      { ...WAITING, state: 'approved' as const, approver: 'Grace Hopper' },
      { ...WAITING, state: 'published' as const, approver: 'Grace Hopper' },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one card at a time
      const view = await drawn(correction);
      expect(view.find('[data-correction-ready]'), correction.state).toBeNull();
    }
  });

  it('asks nothing while Launch is held for a missing Astra review of the version shown (#1781)', async () => {
    const view = await drawn({ ...WAITING, reviewMissingFor: 'v-1' });
    expect(view.find('[data-correction-ready]')).toBeNull();
    expect(view.find('[data-correction-launch-held]')).not.toBeNull();
  });
});
