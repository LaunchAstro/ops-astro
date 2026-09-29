// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('Sol proof, criterion 7: every task page component including Comments is at most 150 lines', () => {
  const file = 'apps/web/src/screens/task/Comments.tsx';
  const lines = readFileSync(file, 'utf8').split('\n');
  const first = lines.findIndex((line) => line.startsWith('export function Comments('));
  expect(first, 'Comments is a mounted task page component').toBeGreaterThanOrEqual(0);
  const last = lines.findIndex((line, at) => at > first && line === '}');
  expect(last, 'Comments has a closing brace').toBeGreaterThan(first);
  expect(last - first + 1).toBeLessThanOrEqual(150);
});
