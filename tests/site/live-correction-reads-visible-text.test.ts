// SPDX-License-Identifier: AGPL-3.0-only
// The live-correction check reads the approved page as a browser shows it: text a reader never
// sees (script, style, template, noscript and the capture's other hidden elements) never counts,
// and every character reference decodes as parse5's tokeniser decodes it. Each crossing approves
// one occurrence and serves a page that changed another; the capture text is the capture's own.
// @ts-expect-error -- jsdom ships no declarations; this proof reads its DOM paragraphs
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { observeLanded, revertCorrection } from '../../packages/core-connectors/src/index.ts';
import { occurrenceOf } from '../../packages/core-connectors/src/site/reconcile.ts';
import {
  accepted,
  approvedJob,
  capturedText,
  observed,
  published,
  target,
} from './visible-text-world.ts';

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

it('non-visible script copy cannot shift observation onto a replacement decoy', async () => {
  const source =
    '<script type="text/plain">We walk alongside you.</script>\n<p>We walk alongside you.</p>\n<p>We walk beside you.</p>\n';
  const job = approvedJob(source);
  const result = await observeLanded(await accepted(job), target, {
    raiseTask: () => Promise.resolve(),
    readDeployment: () =>
      Promise.resolve({ kind: 'ok', value: { revision: published.revision, served: true } }),
    capture: (url) => Promise.resolve({ ok: true, value: { text: paragraphText(source), url } }),
  });
  expect(paragraphText(source)).toBe('We walk alongside you. We walk beside you.');
  expect(result.state).toBe('accepted');
});

it('non-visible script copy cannot hide a completed publish or revert', async () => {
  const source =
    '<script type="text/plain">We walk alongside you.</script>\n<p>We walk alongside you.</p>\n';
  const job = approvedJob(source);
  const observedLive = await observeLanded(await accepted(job), target, {
    raiseTask: () => Promise.resolve(),
    readDeployment: () =>
      Promise.resolve({ kind: 'ok', value: { revision: published.revision, served: true } }),
    capture: (url) =>
      Promise.resolve({
        ok: true,
        value: { text: paragraphText(job.change.files[0]?.after ?? ''), url },
      }),
  });
  const restored = await revertCorrection(
    {
      publishedRevision: published.revision,
      target,
      occurrence: observedLive.occurrence,
      seam: 'revert-17',
      decidedAt: 1_000,
    },
    {
      now: () => 2_000,
      raiseTask: () => Promise.resolve(),
      readBack: () => Promise.resolve({ state: 'absent' }),
      revert: () =>
        Promise.resolve({
          kind: 'ok',
          value: { revision: 'reverted', deploymentId: 'revert-deployment' },
        }),
      readDeployment: () =>
        Promise.resolve({ kind: 'ok', value: { revision: 'reverted', served: true } }),
      capture: () =>
        Promise.resolve({
          ok: true,
          value: { text: paragraphText(source), url: published.liveUrl },
        }),
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
      raiseTask: () => Promise.resolve(),
      readDeployment: () =>
        Promise.resolve({ kind: 'ok', value: { revision: published.revision, served: true } }),
      capture: (url) => Promise.resolve({ ok: true, value: { text: rendered, url } }),
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
  ['inline display:none', '<p style="display:none">We walk alongside you.</p>'],
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

// A paragraph with the `hidden` attribute is never shown, so a correction inside it is never seen.
it('text in a hidden paragraph cannot certify a correction as live', async () => {
  const source = '<p hidden>We walk alongside you.</p>\n<p>Shown text stays.</p>\n';
  const job = approvedJob(source, 'alongside');
  expect((await observed(job, job.change.files[0]?.after ?? '')).state).toBe('accepted');
  expect(await capturedText(source)).toBe('Shown text stays.');
});

// The source placement leaves a `hidden` element out as the capture does, so a page holding one
// elsewhere still places, and goes live with, a correction a reader does see.
it('a hidden element elsewhere on the page still lets a shown correction go live', async () => {
  const source = '<div hidden>Menu</div>\n<p>We walk alongside you.</p>\n';
  const job = approvedJob(source);
  expect(occurrenceOf(job.change, target)).toBeDefined();
  expect((await observed(job, job.change.files[0]?.after ?? '')).state).toBe('live');
});
