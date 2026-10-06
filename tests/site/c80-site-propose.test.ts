// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 source proposal: `site.source.propose` composed as branch, commit and
// request, each a guarded catalogued call, against a double of the source
// control provider behind the transport. Nothing reaches a live system.

import { describe, expect, it } from 'vitest';
import { proposeSource } from '../../packages/core-connectors/src/index.ts';
import {
  AFTER,
  BEFORE,
  DIGEST,
  HEAD,
  REPOSITORY,
  SEAM,
  line,
  proposal,
  provider,
} from './c80-site-provider.ts';

describe('C80 source proposal: each step only after the one before answered', () => {
  it('proposes as branch, commit and request in that order, nothing merged', async () => {
    const site = provider({ content: BEFORE });
    expect(await proposeSource(proposal, site.deps)).toEqual({
      kind: 'ok',
      value: { request: '17', head: HEAD, versionDigest: DIGEST },
    });
    expect(site.sent.map(line)).toEqual([
      `POST /repos/${REPOSITORY}/git/refs`,
      `PUT /repos/${REPOSITORY}/contents/src/pages/about.md`,
      `POST /repos/${REPOSITORY}/pulls`,
    ]);
    expect(site.sent[0]?.body).toEqual({ ref: `refs/heads/${SEAM}`, sha: 'base-commit' });
    expect(site.sent[1]?.body).toMatchObject({ branch: SEAM, sha: 'blob-base' });
    expect(Buffer.from(site.sent[1]?.body['content'] ?? '', 'base64').toString('utf8')).toBe(AFTER);
    expect(site.sent[2]?.body).toMatchObject({ head: SEAM, base: 'main' });
    expect(site.state.content).toBe(BEFORE);
  });

  it('a branch that already exists is the nothing-happened refusal, with nothing else sent', async () => {
    const site = provider({ content: BEFORE, branches: ['main', SEAM] });
    expect(await proposeSource(proposal, site.deps)).toEqual({
      kind: 'refused',
      code: 'PROVIDER_REFUSED',
      proof: 'branch_exists',
    });
    expect(site.sent).toHaveLength(1);
  });

  it('a branch write whose answer cannot be read is unknown, with nothing else sent', async () => {
    const site = provider({
      content: BEFORE,
      answers: { [`POST api.github.com /repos/${REPOSITORY}/git/refs`]: { kind: 'timeout' } },
    });
    expect(await proposeSource(proposal, site.deps)).toEqual({
      kind: 'unknown',
      code: 'PROVIDER_TIMEOUT',
    });
    expect(site.sent).toHaveLength(1);
  });
});

describe('C80 source proposal: a later step that does not answer leaves an unknown', () => {
  it('a commit refused after the branch was made is unknown, never failed, and opens no request', async () => {
    const site = provider({ content: BEFORE, blob: 'blob-moved' });
    expect(await proposeSource(proposal, site.deps)).toEqual({
      kind: 'unknown',
      code: 'PROVIDER_REFUSED',
    });
    expect(site.sent.map((sent) => sent.method)).toEqual(['POST', 'PUT']);
    expect(site.recorded).toContain('PROPOSAL_INCOMPLETE');
  });

  it('an unreadable answer to opening the request is unknown', async () => {
    const site = provider({
      content: BEFORE,
      answers: { [`POST api.github.com /repos/${REPOSITORY}/pulls`]: { kind: 'timeout' } },
    });
    expect(await proposeSource(proposal, site.deps)).toEqual({
      kind: 'unknown',
      code: 'PROVIDER_TIMEOUT',
    });
    expect(site.sent).toHaveLength(3);
  });
});

describe('C80 source proposal: the branch name is a closed grammar', () => {
  it.each([
    'main',
    'seam-5b0e',
    'seam-5b0e2c1a-3d4f-4a6b-8c7d-9e0f1a2b3c4d/../main',
    'seam-5B0E2C1A-3D4F-4A6B-8C7D-9E0F1A2B3C4D',
    'seam-5b0e2c1a-3d4f-4a6b-8c7d-9e0f1a2b3c4dx',
    'seam-5b0e2c1a_3d4f-4a6b-8c7d-9e0f1a2b3c4d',
    'xseam-5b0e2c1a-3d4f-4a6b-8c7d-9e0f1a2b3c4',
  ])('refuses the branch %s with nothing sent', async (branch) => {
    const site = provider({ content: BEFORE });
    expect(await proposeSource({ ...proposal, branch }, site.deps)).toEqual({
      kind: 'refused',
      code: 'SEAM_INVALID',
    });
    expect(site.sent).toEqual([]);
  });
});
