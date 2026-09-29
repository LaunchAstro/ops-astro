// SPDX-License-Identifier: AGPL-3.0-only
//
// C80: the change envelope (release decision section 2) is a refusal at
// proposal time, never a warning a reviewer has to notice, and the captures
// before and after show one word moved and nothing else.

import { describe, expect, it } from 'vitest';
import {
  checkEnvelope,
  compareCaptures,
  type CorrectionTarget,
  type PageObservation,
  type ProposedChange,
} from '../../packages/core-connectors/src/index.ts';

const TARGET: CorrectionTarget = {
  path: 'src/pages/about.astro',
  word: 'alongside',
  replacement: 'beside',
};

const ABOUT = [
  '---',
  "const title = 'About alongside';",
  '---',
  '<Layout title={title}>',
  '  <section class="intro">',
  '    <p>We walk alongside you from the first call.</p>',
  '  </section>',
  '  <p>Our team works alongside yours.</p>',
  '</Layout>',
  '',
].join('\n');

function edit(before: string, from: string, to: string): string {
  const at = before.indexOf(from);
  if (at < 0) throw new Error(`no ${from}`);
  return before.slice(0, at) + to + before.slice(at + from.length);
}

const AGREED = edit(ABOUT, 'walk alongside you', 'walk beside you');

function change(after: string, before = ABOUT, path = TARGET.path) {
  return { files: [{ path, before, after }] };
}

describe('C80 envelope refusal', () => {
  it('accepts the agreed change: one file, one line, one word in a text node', () => {
    expect(checkEnvelope(change(AGREED), TARGET)).toEqual({
      ok: true,
      value: { path: TARGET.path, line: 6, before: 'alongside', after: 'beside' },
    });
  });

  const refusals: [string, ProposedChange][] = [
    ['two words', change(edit(ABOUT, 'walk alongside you', 'walk beside us'))],
    ['a second line', change(edit(AGREED, 'works alongside', 'works beside'))],
    [
      'a markup change on the same line',
      change(edit(AGREED, '<p>We walk', '<p class="x">We walk')),
    ],
    ['a class change', change(edit(AGREED, 'class="intro"', 'class="lead"'))],
    ['the word inside an attribute', change(edit(ABOUT, 'class="intro"', 'class="intro beside"'))],
    ['the word in the frontmatter', change(edit(ABOUT, "'About alongside'", "'About beside'"))],
    ['a different replacement word', change(edit(ABOUT, 'walk alongside you', 'walk next you'))],
    ['a case variant of the word', change(edit(ABOUT, 'walk alongside you', 'walk Beside you'))],
    ['part of a longer word', change(edit(ABOUT, 'walk alongside you', 'walk besideyou'))],
    ['whitespace moved', change(edit(ABOUT, 'walk alongside you', 'walk  beside you'))],
    ['a tab for a space', change(edit(ABOUT, 'walk alongside you', 'walk\tbeside you'))],
    ['a line ending changed', change(AGREED.replace(/\n/g, '\r\n'))],
    ['a line added', change(`${AGREED}<p>new</p>\n`)],
    [
      'another file',
      change(edit(ABOUT, 'walk alongside you', 'walk beside you'), ABOUT, 'src/styles/site.css'),
    ],
    [
      'a stylesheet beside the one line',
      {
        files: [
          { path: TARGET.path, before: ABOUT, after: AGREED },
          { path: 'src/styles/site.css', before: 'p{}', after: 'p{color:red}' },
        ],
      },
    ],
    [
      'a rename',
      {
        files: [
          { path: TARGET.path, before: ABOUT, after: null },
          { path: 'src/pages/about-us.astro', before: null, after: AGREED },
        ],
      },
    ],
    ['no change at all', change(ABOUT)],
    [
      'a combining mark after the word',
      change(edit(ABOUT, 'walk alongside you', 'walk beside\u0301 you')),
    ],
  ];

  it.each(refusals)('refuses %s with CHANGE_ENVELOPE_EXCEEDED', (_name, proposed) => {
    const result = checkEnvelope(proposed, TARGET);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CHANGE_ENVELOPE_EXCEEDED');
  });

  it('refuses the word inside a comment, a script or a style block, which are not body copy', () => {
    const hostile = [
      '<p>We walk <!-- alongside --> you.</p>',
      '<script>const a = "alongside";</script>',
      '<style>.alongside{}</style>',
      '<p title="walk\nalongside">x</p>',
    ];
    for (const line of hostile) {
      const before = `${line}\n`;
      const after = `${line.replace('alongside', 'beside')}\n`;
      expect(checkEnvelope(change(after, before), TARGET).ok, line).toBe(false);
    }
  });

  it('refuses a target that is not a single word, whatever the caller supplies', () => {
    const bad = { ...TARGET, replacement: 'right beside' };
    expect(checkEnvelope(change(AGREED), bad)).toMatchObject({
      ok: false,
      code: 'CHANGE_ENVELOPE_EXCEEDED',
    });
  });
});

function page(overrides: Partial<PageObservation> = {}): PageObservation {
  return {
    url: 'https://www.example.com/about',
    status: 200,
    documentDigest: 'sha256:doc-before',
    text: 'About us. We walk alongside you from the first call. Our team.',
    stylesheets: {
      'https://www.example.com/_astro/site.css': 'sha256:css-1',
    },
    ...overrides,
  };
}

describe('C80 one word only', () => {
  const before = page();
  const after = page({
    documentDigest: 'sha256:doc-after',
    text: 'About us. We walk beside you from the first call. Our team.',
  });
  const decoy = page({
    url: 'https://www.example.com/services',
    text: 'We work alongside your team.',
    documentDigest: 'sha256:decoy',
  });

  it('holds when the word moved, the stylesheets are equal and the decoy is untouched', () => {
    expect(
      compareCaptures({ before, after, decoyBefore: decoy, decoyAfter: decoy, target: TARGET }),
    ).toEqual({
      ok: true,
      value: {
        wordChanged: true,
        restOfPageUnchanged: true,
        stylesheetsUnchanged: true,
        decoyUnchanged: true,
      },
    });
  });

  it('fails when a served stylesheet digest changed', () => {
    const moved = page({
      ...after,
      stylesheets: { 'https://www.example.com/_astro/site.css': 'sha256:css-2' },
    });
    expect(
      compareCaptures({
        before,
        after: moved,
        decoyBefore: decoy,
        decoyAfter: decoy,
        target: TARGET,
      }),
    ).toMatchObject({ ok: false, code: 'NOTHING_ELSE_MOVED_FAILED', fields: ['stylesheets'] });
  });

  it('fails when a stylesheet was added or removed, not only changed', () => {
    const added = page({
      ...after,
      stylesheets: { ...before.stylesheets, 'https://www.example.com/_astro/new.css': 'sha256:n' },
    });
    expect(
      compareCaptures({
        before,
        after: added,
        decoyBefore: decoy,
        decoyAfter: decoy,
        target: TARGET,
      }),
    ).toMatchObject({ ok: false, fields: ['stylesheets'] });
  });

  it('fails when the decoy occurrence moved', () => {
    const decoyAfter = page({ ...decoy, text: 'We work beside your team.' });
    expect(
      compareCaptures({ before, after, decoyBefore: decoy, decoyAfter, target: TARGET }),
    ).toMatchObject({ ok: false, fields: ['decoy'] });
  });

  it('fails when other text on the page moved beside the word', () => {
    const extra = page({ ...after, text: `${after.text} Call now.` });
    expect(
      compareCaptures({
        before,
        after: extra,
        decoyBefore: decoy,
        decoyAfter: decoy,
        target: TARGET,
      }),
    ).toMatchObject({ ok: false, fields: ['page'] });
  });

  it('fails when the word did not change on the live page', () => {
    expect(
      compareCaptures({
        before,
        after: before,
        decoyBefore: decoy,
        decoyAfter: decoy,
        target: TARGET,
      }),
    ).toMatchObject({ ok: false, fields: ['word'] });
  });

  it('fails when the decoy page has no occurrence to watch, rather than passing vacuously', () => {
    const empty = page({ ...decoy, text: 'Nothing here.' });
    expect(
      compareCaptures({ before, after, decoyBefore: empty, decoyAfter: empty, target: TARGET }),
    ).toMatchObject({ ok: false, fields: ['decoy'] });
  });
});
