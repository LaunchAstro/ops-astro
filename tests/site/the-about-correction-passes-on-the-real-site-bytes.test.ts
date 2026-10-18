// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable require-await -- the ports answer synchronously */
//
// #1687: the Tuesday correction checked on the real site before any
// credential exists. The real `src/pages/about.astro` from
// agency-astro-astro main and the served https://agencyastro.com/about
// (fixtures/agency-about, with their source and capture date) pass U92's
// change envelope, source placement and calibration for "walk alongside you"
// becoming "walk beside you", and the live check reads the corrected page
// live. A second word, and a word outside the paragraph, are refused by name.
// Nothing reaches a live system: the providers here answer the saved bytes.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readDocument } from '../../packages/core-connectors/src/capture/page.ts';
import {
  checkEnvelope,
  contentDigest,
  observeLanded,
  publishCorrection,
  versionDigestOf,
  type CorrectionTarget,
  type PublishJob,
  type PublishPorts,
} from '../../packages/core-connectors/src/index.ts';
import { calibrated, occurrenceOf } from '../../packages/core-connectors/src/site/reconcile.ts';

const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/agency-about/${name}`, import.meta.url), 'utf8');

const SOURCE = fixture('about.astro');
const SERVED = fixture('about.live.html');
const PAGE = 'https://agencyastro.com/about';
const PATH = 'src/pages/about.astro';
const TARGET: CorrectionTarget = { path: PATH, word: 'alongside', replacement: 'beside' };
const AFTER = SOURCE.replace('walk alongside you', 'walk beside you');
/** The served page once the correction is live: the paragraph changes, the meta description not. */
const SERVED_AFTER = SERVED.replace(
  /(<p[^>]*phero__lede[^>]*>[^<]*?)walk alongside you/u,
  '$1walk beside you',
);

const text = (html: string): string => {
  const reading = readDocument(html);
  if (typeof reading === 'string') throw new Error(`capture refused: ${reading}`);
  return reading.text;
};

const changeOf = (after: string, target: CorrectionTarget = TARGET) => ({
  target,
  change: { files: [{ path: target.path, before: SOURCE, after }] },
});

function jobOf(after: string, target: CorrectionTarget = TARGET): PublishJob {
  const pin = {
    ...changeOf(after, target),
    preImageDigest: contentDigest(SOURCE),
    baseRevision: '299f9686267445a99c4f4dfd110a6c838e9e34d3',
    pageUrl: PAGE,
    seam: 'seam-about-1687',
  };
  const digest = versionDigestOf(pin);
  return {
    ...pin,
    correctionId: 'correction-1687',
    version: { versionId: 'v1', digest },
    decision: { decisionId: 'd1', decision: 'approve', versionId: 'v1', versionDigest: digest },
  };
}

/** The providers answering the saved bytes: the source file, and the page served before the send. */
function ports(): PublishPorts & { readonly sent: number; readonly raised: string[] } {
  const state = { sent: 0, raised: [] as string[] };
  return {
    get sent() {
      return state.sent;
    },
    raised: state.raised,
    readSource: async () => ({ kind: 'ok', value: { content: SOURCE, revision: 'cf392c6a17' } }),
    readBack: async () => ({ state: 'absent' }),
    publish: async () => {
      state.sent += 1;
      return { kind: 'ok', value: { revision: 'c0rrected', deploymentId: 'dpl_1', liveUrl: PAGE } };
    },
    cancellation: async () => 'none',
    raiseTask: async (reason) => {
      state.raised.push(reason);
    },
    capture: async () => ({ ok: true, value: { text: text(SERVED), url: PAGE } }),
  };
}

describe('the About correction on the real site bytes', () => {
  it('holds the paragraph once as literal markup, and the served page shows it', () => {
    expect(SOURCE.split('walk alongside you')).toHaveLength(2);
    expect(text(SERVED).split('walk alongside you')).toHaveLength(2);
    expect(SERVED_AFTER).not.toBe(SERVED);
  });

  it('passes the envelope, the source placement and the calibration', () => {
    const { change, target } = changeOf(AFTER);
    expect(checkEnvelope(change, target)).toEqual({
      ok: true,
      value: { path: PATH, line: 8, before: 'alongside', after: 'beside' },
    });
    expect(occurrenceOf(change, target)).toEqual({
      left: 'are doing great work but navigating growth blind: no clear course, no guide, no plan. We exist to chart the course, walk ',
      right:
        ' you, and build the brand, digital, and systems that turn a good business into a growing one.',
      index: 0,
    });
    expect(calibrated(change, target, text(SERVED))).toMatchObject({ observed: ['alongside'] });
  });

  it('publishes once, accepted with the calibrated place, and reads the corrected page live', async () => {
    const at = ports();
    const outcome = await publishCorrection(jobOf(AFTER), at);
    expect(outcome).toMatchObject({ state: 'accepted', occurrence: { observed: ['alongside'] } });
    if (outcome.state !== 'accepted') throw new Error('not accepted');
    const served = { kind: 'ok', value: { revision: 'c0rrected', served: true } } as const;
    const observe = async (html: string) =>
      await observeLanded(outcome, TARGET, {
        readDeployment: async () => served,
        capture: async () => ({ ok: true, value: { text: text(html), url: PAGE } }),
        raiseTask: at.raiseTask,
      });
    expect(await observe(SERVED)).toMatchObject({ state: 'accepted' });
    expect(await observe(SERVED_AFTER)).toMatchObject({
      state: 'live',
      occurrence: { observed: ['beside'], liveAt: PAGE },
    });
    expect([at.sent, at.raised]).toEqual([1, []]);
  });
});

const refused = (reason: string) => ({ ok: false, code: 'CHANGE_ENVELOPE_EXCEEDED', reason });

describe('what the envelope refuses on the real bytes', () => {
  it('refuses a second word, named as two words or as more than the one word', async () => {
    const twoWords = { path: PATH, word: 'walk alongside', replacement: 'go beside' };
    const asked = changeOf(SOURCE.replace('walk alongside', 'go beside'), twoWords);
    expect(checkEnvelope(asked.change, asked.target)).toEqual(
      refused('the correction is not one word for one word'),
    );
    const widened = changeOf(SOURCE.replace('walk alongside you', 'walk beside us'));
    expect(checkEnvelope(widened.change, widened.target)).toEqual(
      refused('not the one word replaced in place'),
    );
    const at = ports();
    expect(await publishCorrection(jobOf(widened.change.files[0]?.after ?? ''), at)).toEqual({
      state: 'refused',
      code: 'CHANGE_ENVELOPE_EXCEEDED',
    });
    expect(at.sent).toBe(0);
  });

  it('refuses a word outside the paragraph: the page title and the import', () => {
    const title = { path: PATH, word: 'About', replacement: 'Story' };
    const inTitle = changeOf(SOURCE.replace('title="About us', 'title="Story us'), title);
    expect(checkEnvelope(inTitle.change, inTitle.target)).toEqual(
      refused('the word is not in body copy'),
    );
    const content = { path: PATH, word: 'content', replacement: 'copy' };
    const inImport = changeOf(SOURCE.replace("'../content/pages'", "'../copy/pages'"), content);
    expect(checkEnvelope(inImport.change, inImport.target)).toEqual(
      refused('the word is not in body copy'),
    );
  });
});
