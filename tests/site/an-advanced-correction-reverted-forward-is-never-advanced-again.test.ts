// SPDX-License-Identifier: AGPL-3.0-only
//
// After a publish and its forward revert, the default branch holds the pre-image
// again but its head is the revert's commit: neither the base nor the advanced
// head. Its read back is `unknown`, so no publish ever sends the advance again.
// Mutant that turns it red: read back absent whenever the file is the pre-image.

import { expect, it } from 'vitest';
import { siteRunnerPorts } from '../../packages/core-commands/src/index.ts';
import { dispatchToken } from '../../packages/core-connectors/src/index.ts';
import { APPROVED, BEFORE, SEAM, binding, proposed } from './c80-site-provider.ts';

it('reads unknown after a revert, so nothing is advanced twice', async () => {
  const site = proposed();
  const raised: string[] = [];
  const ports = siteRunnerPorts(binding, {
    ...site.deps,
    // The publish and revert ports capture nothing; a fence that reaches no page stands in.
    capture: {
      pool: { agencyPages: [], otherPages: [], closedPoolReviews: [] },
      resolve: () => Promise.resolve([]),
      transport: () => Promise.resolve({ kind: 'timeout' }),
    },
    raiseTask: (reason) => {
      raised.push(reason);
      return Promise.resolve();
    },
    now: () => 0,
  });
  const token = dispatchToken('site.publish', APPROVED.versionDigest);
  expect(await ports.publish({ ...APPROVED, seam: SEAM, dispatchToken: token })).toMatchObject({
    kind: 'ok',
  });
  expect(await ports.revert({ seam: SEAM, dispatchToken: 'revert-token' })).toMatchObject({
    kind: 'ok',
  });
  expect(site.state.content).toBe(BEFORE);
  site.sent.length = 0;
  expect(await ports.readBack({ seam: SEAM, dispatchToken: token })).toEqual({ state: 'unknown' });
  expect(site.sent.filter((sent) => sent.method !== 'GET')).toEqual([]);
});
