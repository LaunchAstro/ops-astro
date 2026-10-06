// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { CONTENT } from '../operations/s0-5-client-lock-world.ts';

it('custody writes are excluded from existing-task content checks', () => {
  expect(
    CONTENT.map(({ name }) => name),
    'setting a business or client credential does not add content to an existing task',
  ).not.toContain('secret.set');
});
