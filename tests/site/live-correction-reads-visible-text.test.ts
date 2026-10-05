// SPDX-License-Identifier: AGPL-3.0-only
// The live-correction check reads the approved page as a browser shows it: text a reader never
// sees (script, style, template, noscript and the capture's other hidden elements) never counts,
// and every character reference decodes as parse5's tokeniser decodes it. Each crossing approves
// one occurrence and serves a page that changed another; the capture text is the capture's own.
// @ts-expect-error -- jsdom ships no declarations; this proof reads its DOM paragraphs
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import {
  capturePage,
  contentDigest,
  observeLanded,
  publishCorrection,
  revertCorrection,
  versionDigestOf,
  type PublishJob,
} from '../../packages/core-connectors/src/index.ts';
import { occurrenceOf } from '../../packages/core-connectors/src/site/reconcile.ts';

const target = { path: 'src/pages/about.astro', word: 'alongside', replacement: 'beside' };
const published = {
  revision: 'approved-revision',
  deploymentId: 'approved-deployment',
  liveUrl: 'https://agency.example/about/',
};

function approvedJob(before: string, approved = '<p>We walk alongside'): PublishJob {
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

async function accepted(job: PublishJob) {
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
  });
  if (outcome.state !== 'accepted') throw new Error(`Fixture refused: ${outcome.state}`);
  return outcome;
}

function paragraphText(html: string): string {
  const dom = new JSDOM(html);
  try {
    return [...dom.window.document.querySelectorAll('p')]
      .map((paragraph) => paragraph.textContent ?? '')
      .join(' ')
      .replaceAll(/\s+/gu, ' ')
      .trim();
  } finally {
    dom.window.close();
  }
}

/** The text the fenced capture reads from `html` served at the live address. */
async function capturedText(html: string): Promise<string> {
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
async function observed(job: PublishJob, served: string) {
  const text = await capturedText(served);
  return observeLanded(await accepted(job), target, {
    readDeployment: () =>
      Promise.resolve({ kind: 'ok', value: { revision: published.revision, served: true } }),
    capture: () => Promise.resolve({ ok: true, value: { text } }),
  });
}

it('non-visible script copy cannot shift observation onto a replacement decoy', async () => {
  const source =
    '<script type="text/plain">We walk alongside you.</script>\n<p>We walk alongside you.</p>\n<p>We walk beside you.</p>\n';
  const job = approvedJob(source);
  const result = await observeLanded(await accepted(job), target, {
    readDeployment: () =>
      Promise.resolve({ kind: 'ok', value: { revision: published.revision, served: true } }),
    capture: () => Promise.resolve({ ok: true, value: { text: paragraphText(source) } }),
  });
  expect(paragraphText(source)).toBe('We walk alongside you. We walk beside you.');
  expect(result.state).toBe('accepted');
});

it('non-visible script copy cannot hide a completed publish or revert', async () => {
  const source =
    '<script type="text/plain">We walk alongside you.</script>\n<p>We walk alongside you.</p>\n';
  const job = approvedJob(source);
  const observedLive = await observeLanded(await accepted(job), target, {
    readDeployment: () =>
      Promise.resolve({ kind: 'ok', value: { revision: published.revision, served: true } }),
    capture: () =>
      Promise.resolve({
        ok: true,
        value: { text: paragraphText(job.change.files[0]?.after ?? '') },
      }),
  });
  const restored = await revertCorrection(
    {
      publishedRevision: published.revision,
      target,
      change: job.change,
      seam: 'revert-17',
      decidedAt: 1_000,
    },
    {
      now: () => 2_000,
      readBack: () => Promise.resolve({ state: 'absent' }),
      revert: () =>
        Promise.resolve({
          kind: 'ok',
          value: { revision: 'reverted', deploymentId: 'revert-deployment' },
        }),
      readDeployment: () =>
        Promise.resolve({ kind: 'ok', value: { revision: 'reverted', served: true } }),
      capture: () => Promise.resolve({ ok: true, value: { text: paragraphText(source) } }),
    },
  );
  expect({ publish: observedLive.state, revert: restored.state }).toEqual({
    publish: 'live',
    revert: 'reverted',
  });
});

it.each(['nbsp', 'copy', 'eacute'])(
  'the named entity %s is compared as rendered text',
  async (entity) => {
    const source = `<p>We walk alongside you &${entity}; our friends.</p>\n`;
    const job = approvedJob(source);
    const rendered = paragraphText(job.change.files[0]?.after ?? '');
    expect(rendered).not.toContain(`&${entity};`);
    const result = await observeLanded(await accepted(job), target, {
      readDeployment: () =>
        Promise.resolve({ kind: 'ok', value: { revision: published.revision, served: true } }),
      capture: () => Promise.resolve({ ok: true, value: { text: rendered } }),
    });
    expect(result.state).toBe('live');
  },
);

// Approve the first visible paragraph; the served page changes the second one instead.
it.each([
  ['script', '<script>// We walk alongside you.</script>'],
  ['style', '<style>/* We walk alongside you. */</style>'],
  ['template', '<template><div>We walk alongside you.</div></template>'],
  ['noscript', '<noscript>We walk alongside you.</noscript>'],
  ['noembed', '<noembed>We walk alongside you.</noembed>'],
])('hidden %s text cannot make a change to another paragraph pass as live', async (_, hidden) => {
  const source = `${hidden}\n<p>We walk alongside you.</p>\n<p>We walk alongside you.</p>\n`;
  const job = approvedJob(source);
  const elsewhere = `${hidden}\n<p>We walk alongside you.</p>\n<p>We walk beside you.</p>\n`;
  expect(await capturedText(elsewhere)).toBe('We walk alongside you. We walk beside you.');
  expect((await observed(job, elsewhere)).state).toBe('accepted');
  expect((await observed(job, job.change.files[0]?.after ?? '')).state).toBe('live');
});

// The browser reads `&amp` with no semicolon as `&`; a five-entry table left it literal, so the
// approved context matched the second paragraph, which reads `&amp` as written.
it('a legacy reference cannot move the approved context onto another paragraph', async () => {
  const source =
    '<p>Tom &amp Jerry walk alongside you.</p>\n<p>Tom &amp;amp Jerry walk alongside you.</p>\n';
  const job = approvedJob(source, '<p>Tom &amp Jerry walk alongside');
  const elsewhere =
    '<p>Tom &amp Jerry walk alongside you.</p>\n<p>Tom &amp;amp Jerry walk beside you.</p>\n';
  expect(await capturedText(elsewhere)).toBe(
    'Tom & Jerry walk alongside you. Tom &amp Jerry walk beside you.',
  );
  expect((await observed(job, elsewhere)).state).toBe('accepted');
  expect((await observed(job, job.change.files[0]?.after ?? '')).state).toBe('live');
});

it.each([
  ['decimal', '&#233;'],
  ['hex', '&#xE9;'],
  ['hex past five digits', '&#x0000E9;'],
  ['named past the five', '&hellip;'],
  ['legacy without semicolon', '&copy'],
  ['windows-1252 numeric', '&#150;'],
  ['legacy name read inside a longer one', '&notaname;'],
  ['unknown name kept literal', '&zzzz;'],
])('a %s character reference reads as the browser shows it', async (_, reference) => {
  const source = `<p>Caf${reference} folk walk alongside you.</p>\n`;
  const job = approvedJob(source, 'walk alongside');
  expect((await observed(job, job.change.files[0]?.after ?? '')).state).toBe('live');
  expect((await observed(job, source)).state).toBe('accepted');
});

it.each([
  ['inside a script', '<script>let walk = "We walk alongside you";</script>\n', 'walk alongside'],
  ['inside a comment', '<!-- We walk alongside you -->\n<p>Hello.</p>\n', 'walk alongside'],
  ['inside an attribute', '<p title="We walk alongside you">Hello.</p>\n', 'walk alongside'],
  [
    'beside a shadow root the capture cannot read',
    '<template shadowrootmode="open"><p>Hi</p></template>\n<p>We walk alongside you.</p>\n',
    '<p>We walk alongside',
  ],
  ['beside the marker character', '<p> We walk alongside you.</p>\n', '<p> We walk alongside'],
])('an occurrence %s has no observable place, so it never reads live', (_, source, approved) => {
  const job = approvedJob(source, approved);
  expect(job.change.files[0]?.after).not.toBe(source);
  expect(occurrenceOf(job.change, target)).toBeUndefined();
});
