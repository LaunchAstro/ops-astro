// SPDX-License-Identifier: AGPL-3.0-only
//
// A fast-forward publishes the head's whole tree, so the proposal's one commit
// must sit directly on the approved base. A commit pushed onto the seam branch
// before ours makes the proposal `unknown` (`PROPOSAL_NOT_ON_BASE`): no request
// is opened, so nothing is ever advanced. Mutant that turns it red: drop the
// parent check, and the request opens over the intruder's file.

import { expect, it } from 'vitest';
import { proposeSource, type TransportRequest } from '../../packages/core-connectors/src/index.ts';
import { proposal, proposed } from './c80-site-provider.ts';

it('opens no request when another commit landed on the seam branch before ours', async () => {
  const site = proposed();
  site.state.branches = ['main'];
  site.state.request = undefined;
  const deps = {
    ...site.deps,
    transport: async (request: TransportRequest) => {
      const answer = await site.deps.transport(request);
      if (request.url.pathname.endsWith('/git/refs')) {
        site.state.proposalExtras['src/pages/contact.md'] = 'unapproved contact';
        site.state.parents['intruder-commit'] = 'base-commit';
        site.state.proposalParent = 'intruder-commit';
        site.state.proposalHead = 'c0ffee99';
      }
      return answer;
    },
  };
  expect(await proposeSource(proposal, deps)).toEqual({
    kind: 'unknown',
    code: 'PROPOSAL_NOT_ON_BASE',
  });
  expect(site.sent.some((sent) => sent.target.endsWith('/pulls'))).toBe(false);
  expect(site.state.request).toBeUndefined();
});
