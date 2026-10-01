// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 publish binding: the runner's provider ports, each provider call a
// catalogued operation through the one guarded call, against a double of the
// providers behind the transport. Nothing reaches a live system.

import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_HOSTS,
  contentDigest,
  dispatchToken,
  mergeAndFind,
  publishCorrection,
  readServed,
  readSiteSource,
  revertForward,
  versionDigestOf,
  type PublishJob,
  type PublishPorts,
} from '../../packages/core-connectors/src/index.ts';
import { siteRunnerPorts } from '../../packages/core-commands/src/commands/live-correction-ports.ts';
import {
  AFTER,
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
} from './c80-site-provider.ts';

describe('C80 publish binding', () => {
  it('merges the proposal at its pinned head and finds the deployment by the merged commit', async () => {
    const site = proposed();
    expect(await mergeAndFind(binding, { seam: SEAM }, site.deps)).toEqual({
      kind: 'ok',
      value: { revision: MERGED, deploymentId: 'dpl_merged', liveUrl: PAGE },
    });
    expect(site.sent.map(line)).toEqual([
      `PUT /repos/${REPOSITORY}/pulls/17/merge`,
      `GET /v6/deployments?projectId=${PROJECT}&sha=${MERGED}&target=production&limit=1`,
    ]);
    expect(site.sent[0]?.body).toEqual({ sha: HEAD });
  });

  it('waits for the deployment the merge starts, a bounded number of times, then is unknown', async () => {
    const late = proposed();
    late.state.lookupMisses = 2;
    expect(await mergeAndFind(binding, { seam: SEAM }, late.deps)).toMatchObject({ kind: 'ok' });
    expect(late.waits).toEqual([5000, 5000]);
    const never = proposed();
    never.state.lookupMisses = 99;
    expect(await mergeAndFind(binding, { seam: SEAM }, never.deps)).toEqual({
      kind: 'unknown',
      code: 'DEPLOYMENT_NOT_FOUND',
    });
    expect(never.sent.filter((sent) => sent.method === 'PUT')).toHaveLength(1);
    expect(never.waits).toHaveLength(5);
  });

  it('a deployment answered for another commit is unknown, never taken as this one', async () => {
    const site = proposed();
    site.state.lookupCommit = 'f00dbabe';
    expect(await mergeAndFind(binding, { seam: SEAM }, site.deps)).toEqual({
      kind: 'unknown',
      code: 'DEPLOYMENT_COMMIT_MISMATCH',
    });
  });
});

describe('C80 publish binding', () => {
  it('not_mergeable after another worker merged reads the request and is unknown, never failed', async () => {
    const site = proposed();
    if (site.state.request) site.state.request.merged = true;
    expect(await mergeAndFind(binding, { seam: SEAM }, site.deps)).toEqual({
      kind: 'unknown',
      code: 'REQUEST_ALREADY_MERGED',
    });
    expect(site.sent.map(line)).toEqual([
      `PUT /repos/${REPOSITORY}/pulls/17/merge`,
      `GET /repos/${REPOSITORY}/pulls/17`,
    ]);
  });

  it('through the executable, a merge already made under a lapsed lease is unknown with a task raised', async () => {
    const site = proposed();
    if (site.state.request) site.state.request.merged = true;
    const raised: string[] = [];
    const ports: PublishPorts = {
      readSource: async () => await readSiteSource(binding, site.deps),
      publish: async (input) => await mergeAndFind(binding, input, site.deps),
      cancellation: () => Promise.resolve('none'),
      raiseTask: (reason) => {
        raised.push(reason);
        return Promise.resolve();
      },
    };
    const outcome = await publishCorrection(jobFor(), ports);
    expect(outcome).toMatchObject({
      state: 'unknown',
      code: 'REQUEST_ALREADY_MERGED',
      reference: SEAM,
    });
    expect(raised).toEqual(['REQUEST_ALREADY_MERGED']);
  });
});

describe('C80 publish binding', () => {
  it('not_mergeable whose merge state cannot be read is unknown', async () => {
    const site = proposed();
    if (site.state.request) site.state.request.merged = true;
    site.state.answers[`GET api.github.com /repos/${REPOSITORY}/pulls/17`] = json(
      { message: 'boom' },
      500,
    );
    expect(await mergeAndFind(binding, { seam: SEAM }, site.deps)).toEqual({
      kind: 'unknown',
      code: 'MERGE_STATE_UNREAD',
    });
  });

  it('not_mergeable on a request still unmerged stays the nothing-happened refusal', async () => {
    const site = proposed();
    site.state.answers[`PUT api.github.com /repos/${REPOSITORY}/pulls/17/merge`] = json(
      { message: 'no' },
      405,
    );
    expect(await mergeAndFind(binding, { seam: SEAM }, site.deps)).toEqual({
      kind: 'refused',
      code: 'PROVIDER_REFUSED',
      proof: 'not_mergeable',
    });
  });

  it('a seam other than the proposal branch sends nothing', async () => {
    const site = proposed();
    expect(await mergeAndFind(binding, { seam: 'seam-other' }, site.deps)).toEqual({
      kind: 'refused',
      code: 'SEAM_MISMATCH',
    });
    expect(await revertForward(binding, { seam: 'seam-other' }, site.deps)).toEqual({
      kind: 'refused',
      code: 'SEAM_MISMATCH',
    });
    expect(site.sent).toEqual([]);
  });
});

describe('C80 publish binding', () => {
  it('reads the site file on the default branch as text, its blob as the revision', async () => {
    const site = proposed();
    expect(await readSiteSource(binding, site.deps)).toEqual({
      kind: 'ok',
      value: { content: BEFORE, revision: 'blob-base' },
    });
  });

  it('reads a deployment as served only when ready on production, at its commit', async () => {
    const site = proposed();
    site.state.deployments[MERGED] = 'dpl_merged';
    expect(await readServed('dpl_merged', site.deps)).toEqual({
      kind: 'ok',
      value: { revision: MERGED, served: true },
    });
    site.state.answers['GET api.vercel.com /v13/deployments/dpl_merged'] = json({
      id: 'dpl_merged',
      readyState: 'BUILDING',
      target: 'production',
      meta: { githubCommitSha: MERGED },
    });
    expect(await readServed('dpl_merged', site.deps)).toMatchObject({ value: { served: false } });
  });
});

describe('C80 publish binding', () => {
  it('reverts forward: the pre-image written on the default branch at the current blob, its deployment found', async () => {
    const site = proposed();
    site.state.content = AFTER;
    expect(await revertForward(binding, { seam: SEAM }, site.deps)).toEqual({
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
    expect(await revertForward(binding, { seam: SEAM }, site.deps)).toEqual({
      kind: 'refused',
      code: 'CONTENT_DRIFTED',
    });
    expect(site.sent.map((sent) => sent.method)).toEqual(['GET']);
  });
});

describe('C80 publish binding', () => {
  it('every request of the bound ports goes to its own host with its own credential, and the refusals are kept', async () => {
    const site = proposed();
    if (site.state.request) site.state.request.merged = true;
    const fenceRefusals: string[] = [];
    const ports = siteRunnerPorts(binding, {
      ...site.deps,
      capture: {
        pool: { agencyPages: [PAGE], otherPages: [], closedPoolReviews: [] },
        resolve: () => Promise.resolve(['93.184.215.14']),
        transport: () => Promise.resolve({ kind: 'timeout' }),
        record: (refusal) => fenceRefusals.push(refusal.code),
      },
      raiseTask: () => Promise.resolve(),
      now: () => 0,
    });
    await ports.readSource();
    await ports.publish({
      seam: SEAM,
      dispatchToken: dispatchToken('site.publish', 'v'),
      versionDigest: 'v',
    });
    await ports.readDeployment('dpl_merged');
    ports.capture.record?.({
      code: 'CAPTURE_HOST_NOT_CATALOGUED',
      hop: 0,
      origin: 'https://x.example',
    });
    for (const sent of site.sent) {
      expect(CONNECTOR_HOSTS).toContain(sent.host);
      const entry = sent.host === 'api.github.com' ? 'source_control' : 'hosting';
      expect(sent.authorization).toBe(`Bearer token-${entry}`);
    }
    expect(site.sent.map((sent) => sent.host)).toContain('api.vercel.com');
    expect(ports.refusals()).toEqual([
      'PROVIDER_REFUSED',
      'REQUEST_ALREADY_MERGED',
      'CAPTURE_HOST_NOT_CATALOGUED',
    ]);
    expect(fenceRefusals).toEqual(['CAPTURE_HOST_NOT_CATALOGUED']);
  });
});

function jobFor(): PublishJob {
  const change = { files: [{ path: binding.path, before: BEFORE, after: AFTER }] };
  const pin = {
    target: { path: binding.path, word: 'friendly', replacement: 'welcoming' },
    change,
    preImageDigest: contentDigest(BEFORE),
    baseRevision: 'base-commit',
    pageUrl: PAGE,
  };
  const digest = versionDigestOf(pin);
  return {
    correctionId: 'correction-1',
    ...pin,
    version: { versionId: 'version-1', digest },
    decision: {
      decisionId: 'decision-1',
      decision: 'approve',
      versionId: 'version-1',
      versionDigest: digest,
    },
    seam: SEAM,
  };
}
