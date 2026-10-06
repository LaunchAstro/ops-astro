// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 publish binding: the runner's provider ports for one correction's
// proposal, each provider call a catalogued operation through the one guarded
// call, against a double of the providers behind the transport. Nothing
// reaches a live system.

import { describe, expect, it } from 'vitest';
import {
  SITE_OPERATIONS,
  mergeAndFind,
  readServed,
  readSiteSource,
  revertForward,
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
  REVERTED,
  SEAM,
  binding,
  json,
  line,
  proposed,
  type SentRequest,
} from './c80-site-provider.ts';

/** The parameter names of a query, in order. */
const names = (text: string | undefined) =>
  (text ?? '').split('&').map((pair) => pair.split('=')[0]);

/** The catalogued operation a sent request is, by host, method and path template. */
function catalogued(sent: SentRequest) {
  return SITE_OPERATIONS.find(({ connector }) => {
    if (connector.host !== sent.host || connector.method !== sent.method) return false;
    const [templatePath = '', templateQuery] = connector.pathTemplate.split('?');
    const [path = '', query] = sent.target.split('?');
    const pattern = templatePath.split(/\{[a-z]+\*?\}/u);
    let rest = path;
    for (const [index, part] of pattern.entries()) {
      if (index === 0 ? !rest.startsWith(part) : !rest.includes(part)) return false;
      rest = rest.slice(rest.indexOf(part) + part.length);
    }
    return JSON.stringify(names(templateQuery)) === JSON.stringify(names(query));
  });
}

describe('C80 publish binding: every provider call is one catalogued, guarded call', () => {
  it('each request is a catalogued operation on its own host with a credential borrowed for that call', async () => {
    const site = proposed();
    const borrowed: string[] = [];
    const deps = {
      ...site.deps,
      credential: async (entry: 'source_control' | 'hosting') => {
        borrowed.push(entry);
        return await site.deps.credential(entry);
      },
    };
    await readSiteSource(binding, deps);
    await mergeAndFind(binding, APPROVED, deps);
    await readServed('dpl_merged', deps);
    site.state.content = AFTER;
    await revertForward(binding, APPROVED, deps);
    expect(site.sent.length).toBeGreaterThan(5);
    expect(borrowed).toHaveLength(site.sent.length);
    for (const [index, sent] of site.sent.entries()) {
      const operation = catalogued(sent);
      expect(operation, line(sent)).toBeDefined();
      expect(borrowed[index]).toBe(operation?.connector.credential);
      expect(sent.authorization).toBe(`Bearer token-${operation?.connector.credential}`);
    }
  });
});

describe('C80 publish binding: the proposal branch is the only seam', () => {
  it('a publish or revert for a seam other than the proposal branch sends nothing', async () => {
    const site = proposed();
    site.state.content = AFTER;
    const other = 'seam-00000000-0000-4000-8000-000000000000';
    expect(await mergeAndFind(binding, { ...APPROVED, seam: other }, site.deps)).toEqual({
      kind: 'refused',
      code: 'SEAM_MISMATCH',
    });
    expect(await revertForward(binding, { seam: other }, site.deps)).toEqual({
      kind: 'refused',
      code: 'SEAM_MISMATCH',
    });
    expect(site.sent).toEqual([]);
  });
});

describe('C80 publish binding: only the proposed version is merged', () => {
  it('any other approved version is PROPOSAL_SUPERSEDED with nothing sent', async () => {
    const site = proposed();
    const other = { seam: SEAM, versionDigest: 'sha256:another-approved-version' };
    expect(await mergeAndFind(binding, other, site.deps)).toEqual({
      kind: 'refused',
      code: 'PROPOSAL_SUPERSEDED',
    });
    expect(site.sent).toEqual([]);
    expect(site.state.request?.merged).toBe(false);
  });
});

describe('C80 publish binding: the merge is at the proposed head', () => {
  it('merges at the head proposed and finds the deployment by the merged commit', async () => {
    const site = proposed();
    expect(await mergeAndFind(binding, APPROVED, site.deps)).toEqual({
      kind: 'ok',
      value: { revision: MERGED, deploymentId: 'dpl_merged', liveUrl: PAGE },
    });
    expect(site.sent.map(line)).toEqual([
      `PUT /repos/${REPOSITORY}/pulls/17/merge`,
      `GET /v6/deployments?projectId=${PROJECT}&sha=${MERGED}&target=production&limit=1`,
    ]);
    expect(site.sent[0]?.body).toEqual({ sha: HEAD });
  });

  it('a branch moved since the proposal is refused by the provider, never merged', async () => {
    const site = proposed();
    if (site.state.request) site.state.request.head = 'c0ffee99';
    expect(await mergeAndFind(binding, APPROVED, site.deps)).toEqual({
      kind: 'refused',
      code: 'PROVIDER_REFUSED',
      proof: 'merge_conflict',
    });
    expect(site.state.request?.merged).toBe(false);
    expect(site.state.content).toBe(BEFORE);
  });
});

describe('C80 publish binding: not_mergeable is read back by the request merge state', () => {
  it('merged already (another worker under a lapsed lease) is unknown, never failed', async () => {
    const site = proposed();
    if (site.state.request) site.state.request.merged = true;
    expect(await mergeAndFind(binding, APPROVED, site.deps)).toEqual({
      kind: 'unknown',
      code: 'REQUEST_ALREADY_MERGED',
    });
    expect(site.sent.map(line)).toEqual([
      `PUT /repos/${REPOSITORY}/pulls/17/merge`,
      `GET /repos/${REPOSITORY}/pulls/17`,
    ]);
  });

  it('still unmerged stays the nothing-happened refusal', async () => {
    const site = proposed();
    site.state.answers[`PUT api.github.com /repos/${REPOSITORY}/pulls/17/merge`] = json(
      { message: 'no' },
      405,
    );
    expect(await mergeAndFind(binding, APPROVED, site.deps)).toEqual({
      kind: 'refused',
      code: 'PROVIDER_REFUSED',
      proof: 'not_mergeable',
    });
    expect(site.sent.map(line)).toEqual([
      `PUT /repos/${REPOSITORY}/pulls/17/merge`,
      `GET /repos/${REPOSITORY}/pulls/17`,
    ]);
  });

  it('a merge state that cannot be read is unknown', async () => {
    const site = proposed();
    if (site.state.request) site.state.request.merged = true;
    site.state.answers[`GET api.github.com /repos/${REPOSITORY}/pulls/17`] = json({}, 500);
    expect(await mergeAndFind(binding, APPROVED, site.deps)).toEqual({
      kind: 'unknown',
      code: 'MERGE_STATE_UNREAD',
    });
  });
});

describe('C80 publish binding: the deployment is found by the merged commit, a bounded number of tries', () => {
  it('found while the provider creates it, after waits', async () => {
    const site = proposed();
    site.state.lookupMisses = 2;
    expect(await mergeAndFind(binding, APPROVED, site.deps)).toMatchObject({ kind: 'ok' });
    expect(site.waits).toEqual([5000, 5000]);
  });

  it('not found after the bounded tries is unknown, with the merge sent once', async () => {
    const site = proposed();
    site.state.lookupMisses = 99;
    expect(await mergeAndFind(binding, APPROVED, site.deps)).toEqual({
      kind: 'unknown',
      code: 'DEPLOYMENT_NOT_FOUND',
    });
    expect(site.sent.filter((sent) => sent.method === 'PUT')).toHaveLength(1);
    expect(site.sent.filter((sent) => sent.host === 'api.vercel.com')).toHaveLength(6);
    expect(site.waits).toHaveLength(5);
  });

  it('a deployment answered for another commit is unknown, never taken as this one', async () => {
    const site = proposed();
    site.state.lookupCommit = 'f00dbabe';
    expect(await mergeAndFind(binding, APPROVED, site.deps)).toEqual({
      kind: 'unknown',
      code: 'DEPLOYMENT_COMMIT_MISMATCH',
    });
  });
});

describe('C80 publish binding: the reads', () => {
  it('reads the site file on the default branch as text, its blob as the revision', async () => {
    const site = proposed();
    expect(await readSiteSource(binding, site.deps)).toEqual({
      kind: 'ok',
      value: { content: BEFORE, revision: 'blob-base' },
    });
  });

  it('a site file answer that is not canonical base64 is malformed, never decoded leniently', async () => {
    const site = proposed();
    const encoded = Buffer.from(BEFORE, 'utf8').toString('base64');
    site.state.answers[`GET api.github.com /repos/${REPOSITORY}/contents/`] = json({
      sha: 'blob-base',
      content: `${encoded.slice(0, 8)}!*${encoded.slice(8)}`,
      encoding: 'base64',
    });
    expect(await readSiteSource(binding, site.deps)).toEqual({
      kind: 'refused',
      code: 'PROVIDER_RESPONSE_MALFORMED',
    });
    site.state.answers[`GET api.github.com /repos/${REPOSITORY}/contents/`] = json({
      sha: 'blob-base',
      content: `${encoded.slice(0, 8)}\n${encoded.slice(8)}\n`,
      encoding: 'base64',
    });
    expect(await readSiteSource(binding, site.deps)).toMatchObject({
      value: { content: BEFORE },
    });
  });

  it('reads a deployment as served only when ready on production, at its commit', async () => {
    const site = proposed();
    site.state.deployments[MERGED] = 'dpl_merged';
    expect(await readServed('dpl_merged', site.deps)).toEqual({
      kind: 'ok',
      value: { revision: MERGED, served: true },
    });
    const answered = (readyState: string, target: string) => {
      site.state.answers['GET api.vercel.com /v13/deployments/dpl_merged'] = json({
        id: 'dpl_merged',
        readyState,
        target,
        meta: { githubCommitSha: MERGED },
      });
    };
    answered('BUILDING', 'production');
    expect(await readServed('dpl_merged', site.deps)).toMatchObject({ value: { served: false } });
    answered('READY', 'preview');
    expect(await readServed('dpl_merged', site.deps)).toMatchObject({ value: { served: false } });
  });
});

describe('C80 publish binding: the revert', () => {
  it('reverts forward: the pre-image written on the default branch at the current blob, its deployment found', async () => {
    const site = proposed();
    site.state.content = AFTER;
    expect(await revertForward(binding, APPROVED, site.deps)).toEqual({
      kind: 'ok',
      value: { revision: REVERTED, deploymentId: 'dpl_reverted' },
    });
    const write = site.sent.find((sent) => sent.method === 'PUT');
    expect(write?.body).toMatchObject({ branch: 'main', sha: 'blob-base' });
    expect(site.state.content).toBe(BEFORE);
  });

  it('a site file that is not the published change sends no revert', async () => {
    const site = proposed();
    site.state.content = '<p>Someone else edited this.</p>\n';
    expect(await revertForward(binding, APPROVED, site.deps)).toEqual({
      kind: 'refused',
      code: 'CONTENT_DRIFTED',
    });
    expect(site.sent.map((sent) => sent.method)).toEqual(['GET']);
  });
});
