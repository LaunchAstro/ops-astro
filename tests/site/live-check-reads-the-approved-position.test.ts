// SPDX-License-Identifier: AGPL-3.0-only
//
// The live check confirms the approved occurrence where it stood, not a match that moved there.
// When a neighbouring word changes, an equal match can slide across a block boundary into the
// approved index, still holding the expected word. The approved word did not change, so the page
// never reads live, and since it changed in a way no reading ties to the target, a person is asked.

import { expect, it } from 'vitest';
import { readDocument } from '../../packages/core-connectors/src/capture/page.ts';
import {
  checkEnvelope,
  contentDigest,
  observeLanded,
  publishCorrection,
  type PublishJob,
  versionDigestOf,
} from '../../packages/core-connectors/src/index.ts';
import { calibrated, flipped } from '../../packages/core-connectors/src/site/reconcile.ts';

const PAGE = 'https://agency.example/about/';
const target = { path: 'src/pages/about.astro', word: 'typo', replacement: 'fixed' };
const before = '<p>typo fixed typo</p>\n<p>typo x</p>\n';
const after = '<p>fixed fixed typo</p>\n<p>typo x</p>\n';
// Only the paragraph's third word changed; "fixed fixed typo" now spans into the next paragraph.
const live = '<p>typo fixed fixed</p>\n<p>typo x</p>\n';
const change = { files: [{ path: target.path, before, after }] };

function text(html: string): string {
  const reading = readDocument(html);
  if (typeof reading === 'string') throw new Error(`capture refused: ${reading}`);
  return reading.text;
}

function job(): PublishJob {
  const pinned = {
    target,
    change,
    preImageDigest: contentDigest(before),
    baseRevision: 'base',
    pageUrl: PAGE,
    seam: 'request-slide',
  };
  const digest = versionDigestOf(pinned);
  return {
    correctionId: 'correction-slide',
    ...pinned,
    version: { versionId: 'version-1', digest },
    decision: {
      decisionId: 'decision-1',
      decision: 'approve',
      versionId: 'version-1',
      versionDigest: digest,
    },
  };
}

it('a match sliding across a block boundary never reads the unchanged word live', () => {
  const where = calibrated(change, target, text(before));
  expect(where).toBeDefined();
  expect(typeof flipped(text(live), where, 'typo', 'fixed')).not.toBe('object');
});

it('a neighbouring word changed across a block boundary stays accepted and raises a task', async () => {
  expect((await checkEnvelope(change, target)).ok).toBe(true);
  const raised: string[] = [];
  const raiseTask = (reason: string) => {
    raised.push(reason);
    return Promise.resolve();
  };
  const published = { revision: 'approved', deploymentId: 'deployment', liveUrl: PAGE };
  const outcome = await publishCorrection(job(), {
    readBack: () => Promise.resolve({ state: 'absent' as const }),
    readSource: () => Promise.resolve({ kind: 'ok', value: { content: before, revision: 'base' } }),
    cancellation: () => Promise.resolve('none' as const),
    publish: () => Promise.resolve({ kind: 'ok', value: published }),
    raiseTask,
    capture: (url) => Promise.resolve({ ok: true, value: { text: text(before), url } }),
  });
  if (outcome.state !== 'accepted') throw new Error(`not accepted: ${outcome.state}`);
  const observed = await observeLanded(outcome, target, {
    raiseTask,
    readDeployment: () =>
      Promise.resolve({ kind: 'ok', value: { revision: 'approved', served: true } }),
    capture: (url) => Promise.resolve({ ok: true, value: { text: text(live), url } }),
  });
  expect({ observed: observed.state, raised }).toEqual({
    observed: 'accepted',
    raised: ['LIVE_CHECK_UNCONFIRMED'],
  });
});

it('the honest corrected page still reads live at the approved place', () => {
  const where = calibrated(change, target, text(before));
  expect(typeof flipped(text(after), where, 'typo', 'fixed')).toBe('object');
});
