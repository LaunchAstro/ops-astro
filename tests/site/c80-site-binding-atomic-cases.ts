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
  MERGED,
  PAGE,
  PROJECT,
  REPOSITORY,
  SEAM,
  VERSION_PIN,
  binding,
  json,
  line,
  partySite,
  proposed,
  proposal,
} from './c80-site-provider.ts';

export async function writesApprovedImage(): Promise<void> {
  const site = proposed();
  const staleBinding = { ...binding, change: { before: BEFORE, after: 'unapproved bytes' } };
  expect(await mergeAndFind(staleBinding, APPROVED, site.deps)).toEqual({
    kind: 'ok',
    value: { revision: MERGED, deploymentId: 'dpl_merged', liveUrl: PAGE },
  });
  expect(site.sent.map(line)).toEqual([
    `GET /repos/${REPOSITORY}/contents/src/pages/about.md?ref=main`,
    `PUT /repos/${REPOSITORY}/contents/src/pages/about.md`,
    `GET /v6/deployments?projectId=${PROJECT}&sha=${MERGED}&target=production&limit=1`,
  ]);
  expect(site.sent[1]?.body).toEqual({
    branch: 'main',
    sha: 'blob-base',
    content: Buffer.from(AFTER, 'utf8').toString('base64'),
    message: `Live correction ${SEAM}`,
  });
  expect(site.state.content).toBe(AFTER);
  expect(site.state.request?.merged).toBe(false);
}

export async function publishesOnlyApprovedFile(): Promise<void> {
  const site = proposed();
  site.state.branches = ['main'];
  site.state.defaultExtras['src/pages/contact.md'] = 'approved contact';
  const deps = {
    ...site.deps,
    transport: async (request: Parameters<typeof site.deps.transport>[0]) => {
      const answer = await site.deps.transport(request);
      if (request.url.pathname.endsWith('/git/refs')) {
        site.state.proposalExtras['src/pages/contact.md'] = 'unapproved contact';
        site.state.proposalHead = 'c0ffee99';
      }
      return answer;
    },
  };
  const made = await proposeSource(proposal, deps);
  expect(made.kind).toBe('ok');
  if (made.kind !== 'ok') return;
  expect(made.value.head).toBe('c0ffee99');
  site.sent.length = 0;
  expect(
    await mergeAndFind({ ...binding, proposal: { branch: SEAM, ...made.value } }, APPROVED, deps),
  ).toMatchObject({ kind: 'ok', value: { revision: MERGED } });
  expect(site.state.content).toBe(AFTER);
  expect(site.state.defaultExtras['src/pages/contact.md']).toBe('approved contact');
  expect(site.sent.filter((sent) => sent.method === 'PUT')).toHaveLength(1);
  expect(site.sent.some((sent) => sent.target.includes('/pulls/'))).toBe(false);
  expect(site.state.request?.merged).toBe(false);
}

export async function refusesConcurrentEdit(status: number): Promise<void> {
  const site = proposed();
  const concurrent = BEFORE + '<p>Another footer.</p>\n';
  const deps = {
    ...site.deps,
    transport: async (request: Parameters<typeof site.deps.transport>[0]) => {
      if (request.method === 'PUT') {
        site.state.content = concurrent;
        site.state.blob = 'blob-concurrent';
        if (status === 422)
          site.state.answers[`PUT api.github.com /repos/${REPOSITORY}/contents/`] = json(
            {},
            status,
          );
      }
      return await site.deps.transport(request);
    },
  };
  expect(await mergeAndFind(binding, APPROVED, deps)).toEqual({
    kind: 'refused',
    code: 'PROVIDER_REFUSED',
    proof: 'sha_mismatch',
  });
  expect(site.state.content).toBe(concurrent);
  expect(site.state.deployments).toEqual({});
  expect(site.sent.filter((sent) => sent.method === 'PUT')).toHaveLength(1);
  expect(site.sent.some((sent) => sent.target.includes('/pulls/'))).toBe(false);
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
