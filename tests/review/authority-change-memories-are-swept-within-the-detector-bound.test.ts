// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createDetector, signalOf } from '../../apps/api/alerts/detect.ts';

it('successful authority changes keep the detector within its scope bound, swept as they expire', () => {
  const raised: string[] = [];
  let at = 0;
  const detector = createDetector((kind) => raised.push(kind), { scopes: 2, now: () => at });
  for (let n = 0; n < 12; n += 1) {
    at += 60_001;
    const signal = signalOf({
      business: 'alpha',
      person: 'supabase\u0000pat',
      command: 'secret.set',
      refusal: undefined,
      items: 0,
    });
    if (signal === undefined) throw new Error('successful secret.set was not classified');
    detector.observe(signal);
  }
  expect(raised).toHaveLength(12);
  expect(detector.tracked(), 'expired operation keys must be swept').toBeLessThanOrEqual(2);
});
