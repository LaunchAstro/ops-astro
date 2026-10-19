// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof for S2114-1 (#2114, round 1), kept as written: a selector type that names an
// inherited Object property (`constructor`, `toString`, `__proto__`) is refused naming
// selector, never accepted and never thrown.

import { expect, it } from 'vitest';
import { parseAnchor } from '../../packages/core-commands/src/commands/review-anchor.ts';

const base = {
  revisionId: '7d3c1a52-8f0e-4c8b-9a51-0b2f6e4d9c10',
  width: 1480,
};
const spot = {
  type: 'FragmentSelector',
  conformsTo: 'http://www.w3.org/TR/media-frags/',
  value: 'xywh=0,0,10,10',
};

it('inherited selector names are refused rather than stored or thrown', () => {
  const answers = ['constructor', 'toString', '__proto__'].map((type) => {
    try {
      return parseAnchor({ ...base, selector: [spot, { type }] });
    } catch (error) {
      return { threw: error instanceof Error ? error.message : String(error) };
    }
  });
  expect(answers).toStrictEqual(
    Array.from({ length: 3 }, () => ({ ok: false, names: ['selector'] })),
  );
});
