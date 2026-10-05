// SPDX-License-Identifier: AGPL-3.0-only
//
// A correction whose approved occurrence has no place on the served page is published, never
// read live, and raises the recovery task so a person resolves it. Two pages give no place: a
// source whose build drops a duplicate (a false Astro conditional) under a layout whose nav
// already shows the replacement, and a page whose decorative `+++` comment the frontmatter
// fence refuses. Both run the real publish and observe path, the pre-image calibration included.

import { expect, it } from 'vitest';
import { readDocument } from '../../packages/core-connectors/src/capture/page.ts';
import {
  checkEnvelope,
  contentDigest,
  observeLanded,
  publishCorrection,
  type CorrectionTarget,
  type PublishJob,
  type PublishPorts,
  versionDigestOf,
} from '../../packages/core-connectors/src/index.ts';
import { flipped } from '../../packages/core-connectors/src/site/reconcile.ts';

const PAGE = 'https://agency.example/about/';

function text(html: string): string {
  const reading = readDocument(html);
  if (typeof reading === 'string') throw new Error(`capture refused: ${reading}`);
  return reading.text;
}

/** An approved job for the one-file change `before` → `after`, inside the envelope. */
async function approvedJob(target: CorrectionTarget, before: string, after: string) {
  const change = { files: [{ path: target.path, before, after }] };
  expect((await checkEnvelope(change, target)).ok).toBe(true);
  const pinned = {
    target,
    change,
    preImageDigest: contentDigest(before),
    baseRevision: 'abc123',
    pageUrl: PAGE,
    seam: 'request-unplaced',
  };
  const versionDigest = versionDigestOf(pinned);
  const job: PublishJob = {
    correctionId: 'correction-unplaced',
    ...pinned,
    version: { versionId: 'version-1', digest: versionDigest },
    decision: {
      decisionId: 'decision-1',
      decision: 'approve',
      versionId: 'version-1',
      versionDigest,
    },
  };
  return job;
}

/** Publish `before` → `after`, calibrated on `preImage`, then observe `live` served. */
async function publishAndObserve(
  target: CorrectionTarget,
  before: string,
  after: string,
  preImage: string,
  live: string,
) {
  const job = await approvedJob(target, before, after);
  const raised: string[] = [];
  const published = { revision: 'def456', deploymentId: 'dpl_unplaced', liveUrl: PAGE };
  const raiseTask = (reason: string) => {
    raised.push(reason);
    return Promise.resolve();
  };
  const ports: PublishPorts = {
    readBack: () => Promise.resolve({ state: 'absent' as const }),
    readSource: () =>
      Promise.resolve({ kind: 'ok', value: { content: before, revision: 'abc123' } }),
    cancellation: () => Promise.resolve('none' as const),
    publish: () => Promise.resolve({ kind: 'ok', value: published }),
    raiseTask,
    capture: (url) => Promise.resolve({ ok: true, value: { text: text(preImage), url } }),
  };

  const outcome = await publishCorrection(job, ports);
  expect(outcome.state).toBe('accepted');
  if (outcome.state !== 'accepted') throw new Error('not accepted');
  const observed = await observeLanded(outcome, target, {
    raiseTask,
    readDeployment: () =>
      Promise.resolve({ kind: 'ok', value: { revision: published.revision, served: true } }),
    capture: (url) => Promise.resolve({ ok: true, value: { text: text(live), url } }),
  });
  return { outcome, observed: observed.state, raised };
}

it('an unrendered duplicate and a layout nav never make the unchanged heading read live', async () => {
  const target = { path: 'src/pages/about.astro', word: 'Contcat', replacement: 'Contact' };
  const before =
    "---\nimport Layout from '../layouts/Layout.astro';\n---\n<Layout>\n<h1>Contcat</h1>\n{false && <h1>Contcat</h1>}\n</Layout>\n";
  const after = before.replace('<h1>Contcat', '<h1>Contact');
  const unchanged = '<nav>Contact</nav><h1>Contcat</h1>';

  const { outcome, observed, raised } = await publishAndObserve(
    target,
    before,
    after,
    unchanged,
    unchanged,
  );

  expect(typeof flipped(text(unchanged), outcome.occurrence, 'Contcat', 'Contact')).not.toBe(
    'object',
  );
  expect({ observed, raised }).toEqual({ observed: 'accepted', raised: ['LIVE_CHECK_UNPLACED'] });
});

it('a correction with no observable place on its page raises a recovery task', async () => {
  const target = { path: 'src/pages/about.astro', word: 'alongside', replacement: 'beside' };
  const before = '<p>We walk alongside you.</p>\n<!-- +++ -->\n';
  const after = before.replace('alongside', 'beside');

  const { observed, raised } = await publishAndObserve(target, before, after, before, after);

  // The correction stays unconfirmed, and a person is asked to resolve the observation.
  expect(observed).toBe('accepted');
  expect(raised.length).toBeGreaterThan(0);
});
