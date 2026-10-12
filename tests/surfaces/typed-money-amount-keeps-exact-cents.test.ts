// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { minorOf } from '../../packages/ui/src/surfaces/agent/format.ts';

it('a valid typed AUD amount keeps its exact cents', () => {
  expect(Number.isSafeInteger(7036874417766401)).toBe(true);
  expect(minorOf('70368744177664.01', 'AUD')).toBe(7036874417766401);
});
