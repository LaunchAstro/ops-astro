// SPDX-License-Identifier: AGPL-3.0-only

import { expect } from 'vitest';
import {
  mergeAndFind,
  proposeSource,
  revertForward,
  siteBindingFor,
} from '../../packages/core-connectors/src/index.ts';
import {
  AFTER,
  APPROVED,
  BEFORE,
  HEAD,
  PAGE,
  PROJECT,
  REPOSITORY,
  SEAM,
  VERSION_PIN,
  binding,
  line,
  partySite,
  proposed,
  proposal,
} from './c80-site-provider.ts';

export async function writesApprovedImage(): Promise<void> {
  const site = proposed();
  expect(await mergeAndFind(binding, APPROVED, site.deps)).toEqual({
    kind: 'ok',
    value: { revision: HEAD, deploymentId: 'dpl_merged', liveUrl: PAGE },
  });
  expect(site.sent.map(line)).toEqual([
    `GET /repos/${REPOSITORY}/contents/src/pages/about.md?ref=main`,
    `GET /repos/${REPOSITORY}/branches/main/protection`,
    `GET /repos/${REPOSITORY}/git/ref/heads/main`,
    `GET /repos/${REPOSITORY}/pulls/17`,
    `PATCH /repos/${REPOSITORY}/git/refs/heads/main`,
    `GET /repos/${REPOSITORY}/git/ref/heads/main`,
    `GET /v6/deployments?projectId=${PROJECT}&sha=${HEAD}&target=production&limit=1`,
  ]);
  expect(site.sent[4]?.body).toEqual({ sha: HEAD });
  expect(site.state.content).toBe(AFTER);
  expect(site.state.request?.merged).toBe(true);
}

export async function publishesOnlyApprovedFile(): Promise<void> {
  const site = proposed();
  site.state.branches = ['main'];
  site.state.request = undefined;
  site.state.defaultExtras['src/pages/contact.md'] = 'approved contact';
  const deps = {
    ...site.deps,
    transport: async (request: Parameters<typeof site.deps.transport>[0]) => {
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
  // The commit is not one child of the base: no request, so nothing is ever advanced to it.
  expect(await proposeSource(proposal, deps)).toEqual({
    kind: 'unknown',
    code: 'PROPOSAL_NOT_ON_BASE',
  });
  expect(site.state.defaultExtras['src/pages/contact.md']).toBe('approved contact');
  expect(site.state.mainHead).toBe('base-commit');
  expect(site.sent.some((sent) => sent.method === 'PATCH')).toBe(false);
  expect(site.state.request).toBeUndefined();
}

/** Another commit lands on the default branch between the head read and the advance. */
export async function refusesConcurrentEdit(
  touching: 'the same file' | 'another file',
): Promise<void> {
  const site = proposed();
  const concurrent = BEFORE + '<p>Another footer.</p>\n';
  const deps = {
    ...site.deps,
    transport: async (request: Parameters<typeof site.deps.transport>[0]) => {
      if (request.method === 'PATCH') {
        if (touching === 'the same file') site.state.content = concurrent;
        else site.state.defaultExtras['src/pages/contact.md'] = 'edited contact';
        site.state.parents['concurrent-commit'] = 'base-commit';
        site.state.mainHead = 'concurrent-commit';
      }
      return await site.deps.transport(request);
    },
  };
  expect(await mergeAndFind(binding, APPROVED, deps)).toEqual({
    kind: 'refused',
    code: 'PROVIDER_REFUSED',
    proof: 'not_fast_forward',
  });
  expect(site.state.content).toBe(touching === 'the same file' ? concurrent : BEFORE);
  expect(site.state.mainHead).toBe('concurrent-commit');
  expect(site.state.deployments).toEqual({});
  expect(site.sent.filter((sent) => sent.method === 'PATCH')).toHaveLength(1);
  expect(site.sent.some((sent) => sent.method === 'PUT')).toBe(false);
  expect(site.state.request?.merged).toBe(false);
}

export async function refusesChangedBytes(): Promise<void> {
  const site = proposed();
  expect(
    await mergeAndFind(
      binding,
      {
        ...APPROVED,
        change: { files: [{ path: binding.path, before: BEFORE, after: 'unapproved' }] },
      },
      site.deps,
    ),
  ).toEqual({ kind: 'refused', code: 'PROPOSAL_SUPERSEDED' });
  expect(site.sent).toEqual([]);
}

/** A binding of these bytes, made with the approved version's pin and digest. */
const boundWith = (before: string, after: string) =>
  siteBindingFor(partySite, proposal.correction, {
    proposal: { request: '17', head: HEAD, versionDigest: APPROVED.versionDigest },
    change: { before, after },
    version: VERSION_PIN,
  });

/** After a publish, a binding whose bytes are not the approved version's never reverts to them. */
export async function revertsApprovedPreImage(): Promise<void> {
  const site = proposed();
  expect(await mergeAndFind(binding, APPROVED, site.deps)).toMatchObject({ kind: 'ok' });
  const forged = boundWith('<script>unapprovedCode()</script>\n', AFTER);
  if (forged.ok) await revertForward(forged.binding, { seam: SEAM }, site.deps);
  expect(site.state.content).toBe(AFTER);
  expect(forged).toEqual({ ok: false, code: 'PROPOSAL_SUPERSEDED' });
  expect(boundWith(BEFORE, 'unapproved proposal')).toEqual({
    ok: false,
    code: 'PROPOSAL_SUPERSEDED',
  });
  expect(boundWith(BEFORE, AFTER).ok).toBe(true);
}
