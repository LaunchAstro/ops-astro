// SPDX-License-Identifier: AGPL-3.0-only
//
// T2g: `GATE_PENDING`, `GATE_ALREADY_DECIDED` and `AUDIENCE_NOT_PERMITTED`,
// with `FOUR_EYES_REQUIRED`, each have a production constructor in the
// register (build plan section 5), and none is on the list of codes nothing
// produces. `tests/cli/t2g-journey.test.ts` produces the gate codes through a
// real request on both surfaces, and `tests/acceptance/comment-rulings.test.ts`
// the audience one.

import { describe, expect, it } from 'vitest';
import {
  audienceNotPermitted,
  fourEyesRequired,
  gateAlreadyDecided,
  gatePending,
  UNPRODUCED_CODES,
} from '../../packages/core-records/src/register.ts';

describe('T2g the gate codes have production constructors', () => {
  it.each([
    ['GATE_PENDING', gatePending()],
    ['GATE_ALREADY_DECIDED', gateAlreadyDecided('g-1', 'approved')],
    ['AUDIENCE_NOT_PERMITTED', audienceNotPermitted('The effect is a team-only comment.')],
    ['FOUR_EYES_REQUIRED', fourEyesRequired()],
  ] as const)('%s is built by its constructor with a fix a person can act on', (code, refusal) => {
    expect(refusal.refused).toBe(true);
    expect(refusal.code).toBe(code);
    expect(refusal.fixes.length).toBeGreaterThan(0);
  });

  it('lists none of them as unproduced', () => {
    for (const code of [
      'GATE_PENDING',
      'GATE_ALREADY_DECIDED',
      'AUDIENCE_NOT_PERMITTED',
      'FOUR_EYES_REQUIRED',
    ] as const) {
      expect(UNPRODUCED_CODES.has(code), code).toBe(false);
    }
  });
});
