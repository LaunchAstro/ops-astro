// SPDX-License-Identifier: AGPL-3.0-only
//
// A binding carries the bytes its revert writes back and checks against, so a
// publish made through a binding whose bytes are not the approved version's
// would leave a published page its own binding cannot revert. The publish
// refuses such a binding and writes nothing; through a binding that holds the
// approved bytes it publishes, and the revert restores the pre-image.

import { expect, it } from 'vitest';
import { mergeAndFind, revertForward } from '../../packages/core-connectors/src/index.ts';
import { APPROVED, BEFORE, SEAM, binding, proposed } from './c80-site-provider.ts';

it('a publish through stale binding bytes is refused and writes nothing, so every publish stays revertible', async () => {
  const site = proposed();
  const stale = { ...binding, change: { before: BEFORE, after: 'unapproved bytes' } };
  expect(await mergeAndFind(stale, APPROVED, site.deps)).toEqual({
    kind: 'refused',
    code: 'PROPOSAL_SUPERSEDED',
  });
  expect(site.sent).toEqual([]);
  expect(site.state.content).toBe(BEFORE);
  expect(await mergeAndFind(binding, APPROVED, site.deps)).toMatchObject({ kind: 'ok' });
  expect(await revertForward(binding, { seam: SEAM }, site.deps)).toMatchObject({ kind: 'ok' });
  expect(site.state.content).toBe(BEFORE);
});
