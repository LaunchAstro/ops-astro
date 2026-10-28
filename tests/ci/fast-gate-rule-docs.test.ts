// SPDX-License-Identifier: AGPL-3.0-only
// The fast gate replaced full CI on 28 October 2026: CONTRIBUTING.md names
// it and no longer names a superseded gate as current (S2280-1).
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const flat = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replaceAll(/\s+/gu, ' ');

it('Sol proof, criterion 2: CONTRIBUTING.md names no superseded gate as current', () => {
  const text = flat('CONTRIBUTING.md');
  expect(text).toContain('fast gate and DCO, not full CI');
  expect(text).not.toContain('`review evidence for this revision` is a required check');
  expect(
    text.includes('The full set runs in the merge queue') &&
      text.includes('is the only way into it'),
  ).toBe(false);
});
