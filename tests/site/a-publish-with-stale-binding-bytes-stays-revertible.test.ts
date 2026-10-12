// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { mergeAndFind, revertForward } from '../../packages/core-connectors/src/index.ts';
import { APPROVED, BEFORE, SEAM, binding, proposed } from '../site/c80-site-provider.ts';

it('a successful publish with stale binding bytes remains revertible', async () => {
  const site = proposed();
  // This input is explicitly supported by writesApprovedImage in the affected suite.
  const stale = { ...binding, change: { before: BEFORE, after: 'unapproved bytes' } };
  expect(await mergeAndFind(stale, APPROVED, site.deps)).toMatchObject({ kind: 'ok' });
  const reverted = await revertForward(stale, { seam: SEAM }, site.deps);
  expect(reverted, JSON.stringify(reverted)).toMatchObject({ kind: 'ok' });
  expect(site.state.content).toBe(BEFORE);
});
