// SPDX-License-Identifier: AGPL-3.0-only
//
// A word's edges are whole characters. A letter outside the Basic
// Multilingual Plane is two UTF-16 code units, and neither half alone is a
// letter, so a code-unit check took a word inside a longer word for a
// standalone one and certified a swap that changed only part of a word.

import { expect, it } from 'vitest';
import { compareCaptures, type PageObservation } from '../../packages/core-connectors/src/index.ts';

const target = { path: 'src/pages/about.astro', word: 'alongside', replacement: 'beside' };
const decoyBefore: PageObservation = {
  url: 'https://www.example.com/services',
  status: 200,
  documentDigest: 'sha256:decoy',
  text: 'We work alongside your team.',
  html: 'We work alongside your team.',
  stylesheets: {},
};

it.each([
  ['before', 'We walk \u{1D400}alongside you.', 'We walk \u{1D400}beside you.'],
  ['after', 'We walk alongside\u{1D400} you.', 'We walk beside\u{1D400} you.'],
])(
  'fails the page when a letter outside the basic plane stands %s the word',
  (_side, beforeText, afterText) => {
    const before: PageObservation = {
      url: 'https://www.example.com/about',
      status: 200,
      documentDigest: 'sha256:before',
      text: beforeText,
      html: beforeText,
      stylesheets: {},
    };
    const after = { ...before, documentDigest: 'sha256:after', text: afterText, html: afterText };
    expect(
      compareCaptures({ before, after, decoyBefore, decoyAfter: { ...decoyBefore }, target }),
    ).toEqual({ ok: false, code: 'NOTHING_ELSE_MOVED_FAILED', fields: ['page'] });
  },
);

it('fails the decoy when its only occurrence sits inside a longer word', () => {
  const before: PageObservation = {
    url: 'https://www.example.com/about',
    status: 200,
    documentDigest: 'sha256:before',
    text: 'We walk alongside you.',
    html: 'We walk alongside you.',
    stylesheets: {},
  };
  const after = {
    ...before,
    documentDigest: 'sha256:after',
    text: 'We walk beside you.',
    html: 'We walk beside you.',
  };
  const decoy = {
    ...decoyBefore,
    text: 'We work \u{1D400}alongside your team.',
    html: 'We work \u{1D400}alongside your team.',
  };
  expect(
    compareCaptures({ before, after, decoyBefore: decoy, decoyAfter: { ...decoy }, target }),
  ).toEqual({ ok: false, code: 'NOTHING_ELSE_MOVED_FAILED', fields: ['decoy'] });
});
