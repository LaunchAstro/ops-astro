// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof for #2106 (S2106-1), kept as given under a behaviour name: a review
// request whose head is no longer the stored proposal's head is a refusal with
// nothing sent, and the request is left as it was.

import { expect, it } from 'vitest';
import { mergeAndFind } from '../../packages/core-connectors/src/index.ts';
import { APPROVED, HEAD, binding, proposed } from './c80-site-provider.ts';

it('a review request whose head moved since the proposal sends no publish', async () => {
  const site = proposed();
  const moved = 'c0ffee77';
  site.state.parents[moved] = HEAD;
  site.state.request = { number: 17, head: moved, merged: false };
  // The persisted proposal still names HEAD. GitHub's PR read now reports moved.
  const result = await mergeAndFind(binding, APPROVED, site.deps);
  expect({
    published: result.kind === 'ok',
    writes: site.sent.filter((sent) => sent.method !== 'GET').map((sent) => sent.method),
    requestLeftOpen: site.state.request?.merged !== true,
  }).toEqual({ published: false, writes: [], requestLeftOpen: true });
});
