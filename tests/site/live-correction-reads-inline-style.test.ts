// SPDX-License-Identifier: AGPL-3.0-only
// The live-correction check reads an element's inline style: a `display` that hides it, or one the
// reader cannot decide, keeps its text out of the capture and the placement alike, so a correction
// inside it never certifies live.
// @ts-expect-error -- jsdom ships no declarations; this proof reads its computed style
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { occurrenceOf } from '../../packages/core-connectors/src/site/reconcile.ts';
import { approvedJob, capturedText, observed, target } from './visible-text-world.ts';

// Sol's proof of criterion 6 on #1400 (issue #1488): a paragraph CSS hides is never seen.
it('a CSS-hidden paragraph cannot certify a correction as live', async () => {
  const source = '<p style="display:none">We walk alongside you.</p>\n<p>Shown text stays.</p>\n';
  const dom = new JSDOM(source);
  try {
    expect(dom.window.getComputedStyle(dom.window.document.querySelector('p')).display).toBe(
      'none',
    );
  } finally {
    dom.window.close();
  }
  const job = approvedJob(source, 'alongside');
  expect((await observed(job, job.change.files[0]?.after ?? '')).state).toBe('accepted');
});

// The capture reads an inline style as CSS reads it: comments, escapes, case and importance do not
// hide a `display: none`, and text in quotes or url() is not a declaration.
it.each([
  ['upper case', 'DISPLAY : NONE'],
  ['a comment between', 'display/**/:/* x */none'],
  ['an escaped name', String.raw`d\69splay: none`],
  ['an escaped value', String.raw`display: n\one`],
  ['marked important', 'display: none ! important'],
  ['after other declarations', 'color: red; display: none'],
  ['after an at-rule', '@x{}display:none'],
  ['after a media rule', '@media x{}display:none'],
  ['after a block in another declaration', 'color: {} display: none'],
])('an inline display:none %s hides its text from the capture', async (_, style) => {
  const html = `<div style="${style}">We walk alongside you.</div><p>Shown text stays.</p>`;
  expect(await capturedText(html)).toBe('Shown text stays.');
});

it.each([
  ['a shown display', 'display: block'],
  ['display named in a string', `content: 'display:none'`],
  ['display named in a url', 'background: url(display:none)'],
  ['a longer property name', 'display-none: none'],
])('%s keeps its text in the capture', async (_, style) => {
  const html = `<p style="${style}">We walk alongside you.</p>`;
  expect(await capturedText(html)).toBe('We walk alongside you.');
});

// A value the reader cannot decide (a variable, an unknown keyword, a layer revert), or a style
// holding an at-rule or a block it does not follow, may hide the element, so its text is never read and a correction inside it never certifies live.
it.each([
  'display: var(--shown)',
  'display: revert-layer',
  'display: nonsense',
  '@x{}display:block',
])('a correction under the undecidable style %s stays accepted', async (style) => {
  const source = `<div style="${style}"><p>We walk alongside you.</p></div>\n<p>Shown text stays.</p>\n`;
  const job = approvedJob(source, 'alongside');
  expect(await capturedText(source)).toBe('Shown text stays.');
  expect((await observed(job, job.change.files[0]?.after ?? '')).state).toBe('accepted');
});

// The source placement leaves a styled-out element out as the capture does.
it('an inline display:none element elsewhere still lets a shown correction go live', async () => {
  const source = '<nav style="display: none">Menu</nav>\n<p>We walk alongside you.</p>\n';
  const job = approvedJob(source);
  expect(occurrenceOf(job.change, target)).toBeDefined();
  expect((await observed(job, job.change.files[0]?.after ?? '')).state).toBe('live');
});
