// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

const visualTestMode = (source: string, ticket: string): string | undefined => {
  const match = new RegExp(`it(\\.todo|\\.skip)?\\(\\s*'${ticket} visual match`, 'u').exec(
    source,
  );
  return match === null ? undefined : (match[1] ?? '');
};

it('MP-1-2 the visual match has an active test', () => {
  const tests = read('./mp-1-2-fonts-icons-brand.test.tsx');
  expect(visualTestMode(tests, 'MP-1-2')).toBe('');
});

it('MP-1-3 the gallery visual match has an active test', () => {
  const tests = read('./mp-1-3-kit-controls.test.tsx');
  expect(visualTestMode(tests, 'MP-1-3')).toBe('');
});

it('MP-1-6 the unconnected views have an active visual test', () => {
  const tests = read('./mp-1-6-not-connected.test.tsx');
  expect(visualTestMode(tests, 'MP-1-6')).toBe('');
});
