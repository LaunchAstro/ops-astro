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

describe('C80 source proposal', () => {
  it('proposes as branch, commit and request in that order, each a guarded catalogued call', async () => {
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

  it('a branch that already exists stops the proposal with nothing else sent', async () => {
    const site = provider({ content: BEFORE, branches: ['main', SEAM] });
    expect(await proposeSource(proposal, site.deps)).toEqual({
      kind: 'refused',
      code: 'PROVIDER_REFUSED',
      proof: 'branch_exists',
    });
    expect(site.sent).toHaveLength(1);
  });

  it('a commit refused after the branch was made is unknown, never failed, and opens no request', async () => {
    const site = provider({ content: BEFORE, blob: 'blob-moved' });
    const result = await proposeSource(proposal, site.deps);
    expect(result).toEqual({ kind: 'unknown', code: 'PROVIDER_REFUSED' });
    expect(site.sent.map((sent) => sent.method)).toEqual(['POST', 'PUT']);
    expect(site.recorded).toContain('PROPOSAL_INCOMPLETE');
  });

  it('an unreadable answer to opening the request is unknown', async () => {
    const site = provider({
      content: BEFORE,
      answers: { 'POST api.github.com /repos/agency/site/pulls': { kind: 'timeout' } },
    });
    expect(await proposeSource(proposal, site.deps)).toEqual({
      kind: 'unknown',
      code: 'PROVIDER_TIMEOUT',
    });
    expect(site.sent).toHaveLength(3);
  });
});
