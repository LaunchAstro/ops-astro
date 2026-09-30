// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('retake report accounts for every motion frame', () => {
  const report = readFileSync(
    new URL('../../docs/design-system/RETAKE-REPORT.md', import.meta.url),
    'utf8',
  );
  const row = report.match(/^\| SG-1 \| `sidebar\/DS-SIDE-11\/motion` \| (\d+) \|/mu);
  // The private source at roadmap 02aa7ed holds 60 PNGs in this folder.
  expect(Number(row?.[1])).toBe(60);
});
