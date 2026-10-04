// SPDX-License-Identifier: AGPL-3.0-only
//
// The envelope reads a page the way Astro's own compiler reads it, so a word
// counts as body copy only inside a text node the built page shows. Each
// refusal below is an input a hand-written scanner took for body copy: code
// in an expression, a comment, a script, frontmatter in its other spellings,
// an attribute value, and children Astro does not render as written. The
// acceptances guard the other way: ordinary pages stay editable.

import { describe, expect, it } from 'vitest';
import {
  checkEnvelope,
  compareCaptures,
  type CorrectionTarget,
  type PageObservation,
} from '../../packages/core-connectors/src/index.ts';

const TARGET: CorrectionTarget = {
  path: 'src/pages/about.astro',
  word: 'alongside',
  replacement: 'beside',
};

/** `before` with its one `alongside` replaced. */
function proposed(before: string) {
  const after = before.replace('alongside', 'beside');
  return { files: [{ path: TARGET.path, before, after }] };
}

describe('the envelope refuses a word Astro does not render as body copy', () => {
  it.each([
    [
      'markup with an apostrophe inside an expression',
      "{faqs.length ? faqs.map((faq) => (\n  <p>Can't find it? {\n    faq.a\n  }</p>\n)) : track('alongside')}\n",
    ],
    ['a comment after a regex holding a quote', "<p>{/'/.test(s)}</p>\n<!-- x } alongside -->\n"],
    ['a comment after an is:raw brace', '<pre is:raw>{</pre>\n<!-- } alongside -->\n'],
    [
      'a script after an is:raw brace',
      "<pre is:raw>{</pre>\n<script>\n  const clean = (s) => s.replace(/}/g, '');\n  const mode = 'alongside';\n</script>\n",
    ],
    ['an expression holding a regex brace', "<p>{s.replace(/}/g, '') + ' alongside'}</p>\n"],
    ['a template-literal attribute holding a `>`', '<p title=`a > b alongside`>x</p>\n'],
    ['CRLF frontmatter', "---\r\nconst mode = 'alongside';\r\n---\r\n<p>hi</p>\r\n"],
    ['frontmatter after a byte order mark', "﻿---\nconst mode = 'alongside';\n---\n<p>hi</p>\n"],
    ['frontmatter after a blank line', "\n---\nconst mode = 'alongside';\n---\n<p>hi</p>\n"],
    [
      'frontmatter holding a template literal with a fence line',
      "---\nconst md = `\n---\n`;\nconst mode = 'alongside';\n---\n<p>hi</p>\n",
    ],
    ['an is:raw element', '<pre is:raw>We walk alongside you.</pre>\n'],
    [
      'an element whose children set:html replaces',
      '<p set:html={html}>We walk alongside you.</p>\n',
    ],
    ['a style block', '<style>.alongside { color: red; }</style>\n'],
  ])('refuses the word in %s', async (_name, before) => {
    expect(await checkEnvelope(proposed(before), TARGET)).toMatchObject({
      ok: false,
      code: 'CHANGE_ENVELOPE_EXCEEDED',
    });
  });

  it('refuses, and does not throw, after 20,000 nested template expressions', async () => {
    const before = `<p>{${'`${'.repeat(20_000)}}</p>\n<!-- alongside -->\n`;
    expect(await checkEnvelope(proposed(before), TARGET)).toMatchObject({ ok: false });
  });
});

describe('the envelope still accepts body copy', () => {
  it.each([
    [
      'after a list rendered by an expression',
      '<ul>{items.map((i) => <li>{i}</li>)}</ul>\n<p>We walk alongside you.</p>\n',
      2,
    ],
    [
      'after CRLF frontmatter',
      '---\r\nconst x = 1;\r\n---\r\n<p>We walk alongside you.</p>\r\n',
      4,
    ],
    ['after a word with an accent', '<p>Café staff walk alongside you.</p>\n', 1],
  ])('accepts the word %s', async (_name, before, line) => {
    expect(await checkEnvelope(proposed(before), TARGET)).toMatchObject({
      ok: true,
      value: { line },
    });
  });
});

describe('the capture comparison needs a decoy that is another page', () => {
  it('fails the decoy when the decoy captures are the primary page', () => {
    const before: PageObservation = {
      url: 'https://www.example.com/about',
      status: 200,
      documentDigest: 'sha256:doc-before',
      text: 'About us. We walk alongside you.',
      stylesheets: {},
    };
    const after = {
      ...before,
      documentDigest: 'sha256:doc-after',
      text: 'About us. We walk beside you.',
    };
    expect(
      compareCaptures({
        before,
        after,
        decoyBefore: before,
        decoyAfter: { ...before },
        target: TARGET,
      }),
    ).toEqual({ ok: false, code: 'NOTHING_ELSE_MOVED_FAILED', fields: ['decoy'] });
  });
});
