// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { admitsPreference } from '../../packages/core-records/src/preferences/store.ts';

const FIRST = '11111111-1111-4111-8111-111111111111';
const LETTERS = 'abcdefab-1111-4111-8111-111111111111';

it('the closed preference store admits canonical task pin IDs and an explicit empty reset', () => {
  expect(admitsPreference('tasks.pinned', [FIRST])).toBe(true);
  expect(admitsPreference('tasks.pinned', [])).toBe(true);
});

it('pins reject malformed, noncanonical, duplicate and oversized values without widening other keys', () => {
  for (const value of [
    null,
    {},
    true,
    FIRST,
    [3],
    [null],
    ['task-route'],
    [FIRST, FIRST],
    [LETTERS.toUpperCase()],
    [FIRST + '\n'],
    Array.from({ length: 1 }),
    { ids: [FIRST] },
  ]) {
    expect(admitsPreference('tasks.pinned', value), JSON.stringify(value)).toBe(false);
  }
  expect(admitsPreference('tasks.pinned.extra', [FIRST])).toBe(false);
});

it('128 different UUIDs fit; a 129th is rejected rather than silently truncated', () => {
  const pins = Array.from(
    { length: 129 },
    (_, i) => `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
  );
  expect(admitsPreference('tasks.pinned', pins.slice(0, 128))).toBe(true);
  expect(admitsPreference('tasks.pinned', pins)).toBe(false);
});
