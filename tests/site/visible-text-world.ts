// SPDX-License-Identifier: AGPL-3.0-only
// An approved correction on a one-file page, published and observed through the fenced capture, for
// the live-correction proofs that read the page as a browser shows it.
import {
  capturePage,
  contentDigest,
  observeLanded,
  publishCorrection,
  versionDigestOf,
  type PublishJob,
} from '../../packages/core-connectors/src/index.ts';

export const target = { path: 'src/pages/about.astro', word: 'alongside', replacement: 'beside' };
export const published = {
  revision: 'approved-revision',
  deploymentId: 'approved-deployment',
  liveUrl: 'https://agency.example/about/',
};

export function approvedJob(before: string, approved = '<p>We walk alongside'): PublishJob {
  const pin = {
    target,
    change: {
      files: [
        {
          path: target.path,
          before,
          after: before.replace(approved, approved.replace('alongside', 'beside')),
        },
      ],
    },
    preImageDigest: contentDigest(before),
    baseRevision: 'base-revision',
    pageUrl: published.liveUrl,
    seam: 'request-17',
  };
  const digest = versionDigestOf(pin);
  return {
    ...pin,
    correctionId: 'correction-1',
    version: { versionId: 'version-1', digest },
    decision: {
      decisionId: 'decision-1',
      decision: 'approve',
      versionId: 'version-1',
      versionDigest: digest,
    },
  };
}

export async function accepted(job: PublishJob): Promise<Parameters<typeof observeLanded>[0]> {
  const outcome = await publishCorrection(job, {
    readSource: () =>
      Promise.resolve({
        kind: 'ok',
        value: { content: job.change.files[0]?.before ?? '', revision: 'base-revision' },
      }),
    readBack: () => Promise.resolve({ state: 'absent' }),
    publish: () => Promise.resolve({ kind: 'ok', value: published }),
    cancellation: () => Promise.resolve('none'),
    raiseTask: () => Promise.resolve(),
    // The page as served before the change: the approved place is calibrated on it.
    capture: async (url) => ({
      ok: true,
      value: { text: await capturedText(job.change.files[0]?.before ?? ''), url },
    }),
  });
  if (outcome.state !== 'accepted') throw new Error(`Fixture refused: ${outcome.state}`);
  return outcome;
}

/** The text the fenced capture reads from `html` served at the live address. */
export async function capturedText(html: string): Promise<string> {
  const captured = await capturePage(published.liveUrl, {
    pool: { agencyPages: [published.liveUrl], otherPages: [], closedPoolReviews: [] },
    resolve: () => Promise.resolve(['93.184.215.14']),
    transport: () =>
      Promise.resolve({
        kind: 'answer',
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: new TextEncoder().encode(html),
      }),
  });
  if (!captured.ok) throw new Error(`Capture refused: ${captured.code}`);
  return captured.value.text;
}

/** Observation of an approved job against the page as served. */
export async function observed(job: PublishJob, served: string): ReturnType<typeof observeLanded> {
  const text = await capturedText(served);
  return observeLanded(await accepted(job), target, {
    raiseTask: () => Promise.resolve(),
    readDeployment: () =>
      Promise.resolve({ kind: 'ok', value: { revision: published.revision, served: true } }),
    capture: (url) => Promise.resolve({ ok: true, value: { text, url } }),
  });
}
