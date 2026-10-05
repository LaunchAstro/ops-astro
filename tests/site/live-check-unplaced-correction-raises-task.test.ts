// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable require-await -- the ports answer synchronously */
//
// A published correction whose approved occurrence has no place on the served
// page can never be confirmed live by the check. It stays accepted, and a
// recovery task asks a person to confirm the page by eye; it is never left
// accepted with nobody told (catalogue #953). Here the place is lost because
// the served page captured before dispatch does not show the source's copy of
// the word where the source puts it, so the calibration keeps no place.

import { expect, it } from 'vitest';
import { readDocument } from '../../packages/core-connectors/src/capture/page.ts';
import {
  checkEnvelope,
  contentDigest,
  observeLanded,
  publishCorrection,
  versionDigestOf,
  type Accepted,
  type CorrectionTarget,
  type PublishJob,
  type PublishPorts,
} from '../../packages/core-connectors/src/index.ts';

const published = {
  revision: 'def456',
  deploymentId: 'dpl_953',
  liveUrl: 'https://physio.example/contact/',
};

function seen(html: string): string {
  const reading = readDocument(html);
  if (typeof reading === 'string') throw new Error(`capture refused: ${reading}`);
  return reading.text;
}

function approvedJob(target: CorrectionTarget, before: string): PublishJob {
  const after = before.replace(target.word, target.replacement);
  const pinned = {
    target,
    change: { files: [{ path: target.path, before, after }] },
    preImageDigest: contentDigest(before),
    baseRevision: 'abc123',
    pageUrl: published.liveUrl,
    seam: 'request-953-3',
  };
  const versionDigest = versionDigestOf(pinned);
  return {
    correctionId: 'correction-953-3',
    ...pinned,
    version: { versionId: 'version-1', digest: versionDigest },
    decision: {
      decisionId: 'decision-1',
      decision: 'approve',
      versionId: 'version-1',
      versionDigest,
    },
  };
}

function observe(accepted: Accepted, target: CorrectionTarget, html: string) {
  return observeLanded(accepted, target, {
    readDeployment: async () => ({
      kind: 'ok',
      value: { revision: published.revision, served: true },
    }),
    capture: async () => ({ ok: true, value: { text: seen(html) } }),
  });
}

/** Publishes with `preImage` as the served page before dispatch, then observes each served page. */
async function publishAndObserve(
  target: CorrectionTarget,
  before: string,
  preImage: string,
  served: Record<string, string>,
) {
  const job = approvedJob(target, before);
  expect((await checkEnvelope(job.change, target)).ok).toBe(true);
  const raised: string[] = [];
  const base: Omit<PublishPorts, 'capture'> = {
    readBack: async () => ({ state: 'absent' }),
    readSource: async () => ({ kind: 'ok', value: { content: before, revision: 'abc123' } }),
    cancellation: async () => 'none',
    publish: async () => ({ kind: 'ok', value: published }),
    raiseTask: async (reason) => {
      raised.push(reason);
    },
  };
  const ports = {
    ...base,
    capture: async () => ({ ok: true as const, value: { text: seen(preImage) } }),
  };
  const outcome = await publishCorrection(job, ports);
  if (outcome.state !== 'accepted') return { outcome: outcome.state, raised: raised.length };
  const observed = Object.fromEntries(
    await Promise.all(
      Object.entries(served).map(async ([name, html]) => [
        name,
        (await observe(outcome, target, html)).state,
      ]),
    ),
  );
  return { outcome: outcome.state, raised: raised.length, observed };
}

it('a correction the served page gives no place stays accepted and raises a recovery task', async () => {
  const target = { path: 'src/pages/contact.astro', word: 'Contcat', replacement: 'Contact' };
  const before =
    "---\nimport Layout from '../layouts/Layout.astro';\n---\n<Layout>\n<h2>Contcat</h2>\n<p>Call us.</p>\n{closedForHolidays && <h2>Contcat</h2>}\n</Layout>\n";
  const nav = '<header><nav><a href="/contact">Contact</a></nav></header>';
  const result = await publishAndObserve(
    target,
    before,
    `${nav}<main><h2>Contcat</h2><p>Call us.</p></main>`,
    {
      corrected: `${nav}<main><h2>Contact</h2><p>Call us.</p></main>`,
      unchanged: `${nav}<main><h2>Contcat</h2><p>Call us.</p></main>`,
    },
  );
  expect(result).toEqual({
    outcome: 'accepted',
    raised: 1,
    observed: { corrected: 'accepted', unchanged: 'accepted' },
  });
});

it('a correction whose word the served page does not show stays accepted and raises a recovery task', async () => {
  const target = { path: 'src/pages/about.astro', word: 'alongside', replacement: 'beside' };
  const before = '<p>We walk alongside you.</p>\n';
  const result = await publishAndObserve(target, before, '<p>Page moved. See our new site.</p>', {
    corrected: '<p>We walk beside you.</p>',
  });
  expect(result).toEqual({ outcome: 'accepted', raised: 1, observed: { corrected: 'accepted' } });
});
