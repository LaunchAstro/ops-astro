// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// Proofs from the independent review of #1408 (round 1), retitled by what they prove; their bodies are as written.
import { afterEach, expect, it } from 'vitest';
import { press, typeInto, unmountAll } from './perspective-support.tsx';
import { keysOf, todos } from './todos-support.tsx';

afterEach(unmountAll);
it('Enter keeps the due:soon scope and its matching rows', async () => {
  const { view } = await todos();
  await typeInto(view, '#todos-search', 'due:soon');
  expect(keysOf(view)).toEqual(['Proj-Charlie', 'Proj-Delta']);
  await press(view, '#todos-search', 'Enter');
  expect(keysOf(view)).toEqual(['Proj-Charlie', 'Proj-Delta']);
  expect(view.find('[data-todos-chip="due"]')?.textContent).toContain('soon');
});
