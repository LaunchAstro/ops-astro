// SPDX-License-Identifier: AGPL-3.0-only
//
// The envelope fails closed (release decision D21-2): it admits a word only
// where it can prove the word sits in a body-copy text node, and refuses
// whatever it cannot read. A refused valid correction costs a person's
// approval; an admitted code edit would ship code. One case per scanner state:
// the frontmatter (its fences, strings, template literals and comments), an
// expression, a tag, a comment and a script or style block.

import { describe, expect, it } from 'vitest';
import { checkEnvelope, type CorrectionTarget } from '../../packages/core-connectors/src/index.ts';

const TARGET: CorrectionTarget = {
  path: 'src/pages/about.astro',
  word: 'friendly',
  replacement: 'welcoming',
};

function verdict(before: string) {
  const after = before.replace('friendly', 'welcoming');
  return checkEnvelope({ files: [{ path: TARGET.path, before, after }] }, TARGET);
}

function refusedEach(sources: readonly string[]) {
  for (const before of sources) {
    expect(verdict(before), before).toMatchObject({
      ok: false,
      code: 'CHANGE_ENVELOPE_EXCEEDED',
    });
  }
}

describe('Envelope frontmatter, read by the served-page fence grammar', () => {
  it('holds a paragraph below a closing fence with trailing whitespace', () => {
    const before = "---\nconst marker = 'plain';\n--- \n<p>We are a friendly studio.</p>\n";
    expect(verdict(before)).toEqual({
      ok: true,
      value: { path: TARGET.path, line: 4, before: 'friendly', after: 'welcoming' },
    });
  });

  it('refuses a word in a frontmatter template literal that holds a fence line', () => {
    refusedEach(['---\nconst message = `{\n---\nfriendly\n`;\n---\n<p>Unchanged.</p>\n']);
  });

  it('refuses body copy when a frontmatter string, template or comment could hide the fence', () => {
    refusedEach([
      '---\nconst a = `\n---\n<p>We are a friendly studio.</p>\n`;\n',
      '---\n/*\n---\n<p>We are a friendly studio.</p>\n*/\n',
      "---\nconst a = 'one \\\n---\n<p>We are a friendly studio.</p>\n';\n",
      "---\nconst a = '---';\n---\n<p>We are a friendly studio.</p>\n",
      '---\ntitle = "x"\n+++\n<p>We are a friendly studio.</p>\n',
      '---\nconst a = 1;\n---\n<p>We are a friendly studio.</p>\n---\n',
      '<p>x</p>\n---\nconst a = 1;\n---\n<p>We are a friendly studio.</p>\n',
    ]);
  });
});

describe('Envelope expressions, tags, comments and raw blocks', () => {
  it('refuses a word in or after an expression it cannot read, a quoted brace included', () => {
    refusedEach([
      "<p>{'}' + 'friendly'}</p>\n",
      '<p>{"}" + "friendly"}</p>\n',
      '<p>{`}` + `friendly`}</p>\n',
      '<p>{/* } */ "friendly"}</p>\n',
      '<p>{a < b ? <b>x</b> : 1} friendly</p>\n',
      "<p title={x > 1 ? 'friendly' : 'y'}>x</p>\n",
      '<p title=`friendly`>x</p>\n',
      '<p>}</p>\n<p>We are a friendly studio.</p>\n',
    ]);
  });

  it('holds body copy after a plain expression and a plain attribute expression', () => {
    const before = '<Layout title={title}>\n<p>{name.first} is a friendly studio.</p>\n';
    expect(verdict(before)).toMatchObject({ ok: true, value: { line: 2 } });
  });

  it('refuses a word in a comment or a script or style block, and holds it after one', () => {
    refusedEach([
      "<p><!-- '} --> <!-- friendly --></p>\n",
      '<p><!-- open friendly</p>\n',
      '<script>let s = "</scr" + "ipt>"; friendly</script>\n',
      '<style>p { content: "}" } .friendly {}</style>\n',
    ]);
    const after = "<p><!-- '} --></p>\n<script>if (a) { b('}'); }</script>\n<p>friendly</p>\n";
    expect(verdict(after)).toMatchObject({ ok: true, value: { line: 3 } });
  });
});
