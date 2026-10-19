// SPDX-License-Identifier: AGPL-3.0-only
//
// The publish is pinned to the approved base. A default branch whose head is not
// the base sends nothing (`BASE_MOVED`); one that moves between that read and the
// send is refused by the provider's fast-forward with nothing applied, a proven
// refusal. Mutants that turn it red: remove the head-equals-base check (the first
// case sends); drop 422 from the declared proofs (the second case is unknown).

import { expect, it } from 'vitest';
import { mergeAndFind, type TransportRequest } from '../../packages/core-connectors/src/index.ts';
import { APPROVED, BEFORE, binding, proposed } from './c80-site-provider.ts';

const writes = (sent: readonly { method: string }[]) => sent.filter((one) => one.method !== 'GET');

it('sends nothing when the default branch moved past the base', async () => {
  const site = proposed();
  site.state.parents['other-commit'] = 'base-commit';
  site.state.mainHead = 'other-commit';
  expect(await mergeAndFind(binding, APPROVED, site.deps)).toEqual({
    kind: 'refused',
    code: 'BASE_MOVED',
  });
  expect(writes(site.sent)).toEqual([]);
  expect(site.state.content).toBe(BEFORE);
  expect(site.state.mainHead).toBe('other-commit');
});

it('is a proven refusal, with nothing applied, when the branch moves in the window', async () => {
  const site = proposed();
  const deps = {
    ...site.deps,
    transport: async (request: TransportRequest) => {
      if (request.method === 'PATCH') {
        site.state.parents['other-commit'] = 'base-commit';
        site.state.mainHead = 'other-commit';
      }
      return await site.deps.transport(request);
    },
  };
  expect(await mergeAndFind(binding, APPROVED, deps)).toEqual({
    kind: 'refused',
    code: 'PROVIDER_REFUSED',
    proof: 'not_fast_forward',
  });
  expect(writes(site.sent).map((one) => one.method)).toEqual(['PATCH']);
  expect(site.state.content).toBe(BEFORE);
  expect(site.state.mainHead).toBe('other-commit');
  expect(site.state.request?.merged).toBe(false);
});
