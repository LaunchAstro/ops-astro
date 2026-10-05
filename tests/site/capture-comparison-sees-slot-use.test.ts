// SPDX-License-Identifier: AGPL-3.0-only
//
// A component can render the word in its slot as a link, an attribute or a
// form value as well as visible text, so a one-word swap there changes more
// than copy. The capture comparison reads the served document as well as its
// visible text, and certifies a pair only when the two documents differ by the
// one word (catalogue #782).

import { expect, it } from 'vitest';
import {
  compareCaptures,
  type CorrectionTarget,
  type PageObservation,
} from '../../packages/core-connectors/src/index.ts';

const PAGE = 'https://agency.example/blog/launch/';
const DECOY = 'https://agency.example/about/';

/** One fenced capture: the served document, and its visible text as the fence reads it. */
function observed(
  url: string,
  html: string,
  text: string,
  digest: string,
): PageObservation & { readonly html: string } {
  return {
    url,
    status: 200,
    documentDigest: digest,
    text,
    html,
    stylesheets: { 'https://agency.example/site.css': 'sheet-1' },
  };
}

function compare(target: CorrectionTarget, before: [string, string], after: [string, string]) {
  const decoy = observed(
    DECOY,
    `<p>We walk ${target.word} you.</p>`,
    `We walk ${target.word} you.`,
    'decoy-1',
  );
  return compareCaptures({
    before: observed(PAGE, ...before, 'page-1'),
    after: observed(PAGE, ...after, 'page-2'),
    decoyBefore: decoy,
    decoyAfter: decoy,
    target,
  });
}

it('a swap a component also renders into a link is not certified as only the word', () => {
  const target = { path: 'src/pages/blog/launch.astro', word: 'astro', replacement: 'react' };
  const result = compare(
    target,
    ['<p>Tagged <a href="/tags/astro">astro</a></p>', 'Tagged astro'],
    ['<p>Tagged <a href="/tags/react">react</a></p>', 'Tagged react'],
  );
  expect(result).toEqual({ ok: false, code: 'NOTHING_ELSE_MOVED_FAILED', fields: ['page'] });
});

it('a swap that changes only the word in the document is certified', () => {
  const target = { path: 'src/pages/blog/launch.astro', word: 'alongside', replacement: 'beside' };
  const result = compare(
    target,
    ['<p>We walk alongside you.</p>', 'We walk alongside you.'],
    ['<p>We walk beside you.</p>', 'We walk beside you.'],
  );
  expect(result.ok).toBe(true);
});
