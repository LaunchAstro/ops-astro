// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

it('MP-1-4 the visual-match checklist has a runnable named test', () => {
  const source = readFileSync(`${root}tests/surfaces/mp-1-4-type-scale.test.ts`, 'utf8');
  expect(/it\(\s*['"]MP-1-4 visual match:/u.test(source)).toBe(true);
});

it('MP-1-5 the visual-match checklist has a runnable named test', () => {
  const source = readFileSync(`${root}tests/surfaces/mp-1-5-charts.test.tsx`, 'utf8');
  expect(/it\(\s*['"]MP-1-5 visual match:/u.test(source)).toBe(true);
});
