// SPDX-License-Identifier: AGPL-3.0-only
//
// The publish moves the default branch to the proposal's head commit as a
// fast-forward from the approved base, and sends nothing else: no contents write
// on the default branch, no merge, no `force`. The request then reads merged, and
// the published revision is the head itself. Mutants that turn it red: send the
// head read just before instead of the proposal row's head; restore the contents
// write; declare and send `force`.

import { expect, it } from 'vitest';
import { mergeAndFind } from '../../packages/core-connectors/src/index.ts';
import {
  AFTER,
  APPROVED,
  HEAD,
  PAGE,
  PROJECT,
  REPOSITORY,
  binding,
  line,
  proposed,
} from './c80-site-provider.ts';

it('advances main from the approved base to the proposed head, and sends nothing else', async () => {
  const site = proposed();
  expect(await mergeAndFind(binding, APPROVED, site.deps)).toEqual({
    kind: 'ok',
    value: { revision: HEAD, deploymentId: 'dpl_merged', liveUrl: PAGE },
  });
  expect(site.sent.map(line)).toEqual([
    `GET /repos/${REPOSITORY}/contents/src/pages/about.md?ref=main`,
    `GET /repos/${REPOSITORY}/branches/main/protection`,
    `GET /repos/${REPOSITORY}/git/ref/heads/main`,
    `PATCH /repos/${REPOSITORY}/git/refs/heads/main`,
    `GET /repos/${REPOSITORY}/git/ref/heads/main`,
    `GET /v6/deployments?projectId=${PROJECT}&sha=${HEAD}&target=production&limit=1`,
  ]);
  expect(site.sent[3]?.body).toEqual({ sha: HEAD });
  expect(site.state.mainHead).toBe(HEAD);
  expect(site.state.content).toBe(AFTER);
  expect(site.state.request?.merged).toBe(true);
});

it('advances to the proposal row’s head even when a later commit sits on the seam branch', async () => {
  const site = proposed();
  // Another commit pushed on the seam branch after the proposal: its head is not the approved one.
  site.state.proposalHead = 'c0ffee77';
  site.state.parents['c0ffee77'] = HEAD;
  site.state.parents[HEAD] = 'base-commit';
  expect(await mergeAndFind(binding, APPROVED, site.deps)).toMatchObject({
    kind: 'ok',
    value: { revision: HEAD },
  });
  const advances = site.sent.filter((sent) => sent.method === 'PATCH');
  expect(advances.map((sent) => sent.body)).toEqual([{ sha: HEAD }]);
});
