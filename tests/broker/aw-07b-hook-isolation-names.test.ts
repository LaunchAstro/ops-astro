// SPDX-License-Identifier: AGPL-3.0-only
// This inventory checks the required named boundaries, not the absence of leaks.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('AW-07b isolation (hook): the hook suite names client-to-client and person-to-person cases', () => {
  const source = readFileSync(resolve(import.meta.dirname, 'aw-07b-hook.test.ts'), 'utf8');
  const names = [...source.matchAll(/\bit\('([^']+)'/gu)].map((match) => match[1] ?? '');
  expect(names.length, 'the actual hook tests were inventoried').toBeGreaterThanOrEqual(8);
  const isolation = names.filter((name) => /isolation.*hook/iu.test(name));
  expect(
    isolation.some((name) => /business/iu.test(name)),
    'business boundary positive control',
  ).toBe(true);
  const boundaries = ['client', 'person'].filter((boundary) =>
    isolation.some((name) => new RegExp(boundary, 'iu').test(name)),
  );
  expect(boundaries, 'each applicable boundary must have a named hook isolation case').toEqual([
    'client',
    'person',
  ]);
});
