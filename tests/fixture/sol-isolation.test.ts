// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

it('Sol proof, criterion 3: T4 isolation names and exercises every client-data boundary', () => {
  const suites = readdirSync('tests/fixture')
    .filter((name) => name.endsWith('.test.ts') && !name.startsWith('sol-'))
    .map((name) => readFileSync(`tests/fixture/${name}`, 'utf8'))
    .join('\n');
  const names = [...suites.matchAll(/\bit\(['"]([^'"]+)/gu)].map((match) => match[1]);
  for (const boundary of ['business to business', 'client to client', 'person to person']) {
    expect(names).toContain(`T4 isolation: ${boundary}`);
  }
  expect(suites.includes('executeRead(')).toBe(true);
});
