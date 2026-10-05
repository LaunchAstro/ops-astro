// SPDX-License-Identifier: AGPL-3.0-only
//
// The envelope reads the page the compiler prints, token by token, as a
// browser does. A word passes only in a character token in data state,
// inside a tag printed where the source has it, after a tag that follows the
// last expression. Whatever the grammar does not know is refused.
//
// The pages here go straight to that printed-output layer, compiled as the
// check's worker compiles them but past its source check (`page-source.ts`,
// whose own proof is `envelope-page-runs-no-code-of-its-own.test.ts`), so
// each rule of the token grammar is proven on its own.

import { transform } from '@astrojs/compiler';
import { stripTypeScriptTypes } from 'node:module';
import { describe, expect, it } from 'vitest';
import { checkEnvelope } from '../../packages/core-connectors/src/index.ts';
import { swapsOnlyBodyCopy } from '../../packages/core-connectors/src/site/body-copy-tokens.ts';

async function printed(page: string): Promise<string | undefined> {
  const result = await transform(page, { filename: 'page.astro' });
  if (result.diagnostics.some(({ severity }) => severity === 1)) return undefined;
  return stripTypeScriptTypes(result.code, { mode: 'strip' });
}

async function edit(word: string, replacement: string, before: string) {
  const [compiledBefore, compiledAfter] = [
    await printed(before),
    await printed(before.replace(word, replacement)),
  ];
  const ok =
    compiledBefore !== undefined &&
    compiledAfter !== undefined &&
    swapsOnlyBodyCopy(compiledBefore, compiledAfter, { word, replacement });
  return { ok };
}

describe('a word the built page reads inside a tag is refused', () => {
  it.each([
    ['an expression', '<p>Look <{""}img src="x" alt here</p>\n'],
    ['an empty fragment', '<p>Look <<></>img src="x" alt here</p>\n'],
    ['a component', '<p>Look <<Empty />img src="x" alt here</p>\n'],
    ['an expression, behind a slash', '<p>Look </{""}img src="x" alt here</p>\n'],
    // Empty prints nothing here; one that prints `img alt="` puts the word in that attribute.
    ['a component, then a tag', '<p>Look <<Empty /><b>here</b> now</p>\n'],
  ])('after a dangling less-than and %s', async (_name, before) => {
    expect(await edit('here', 'hidden', before)).toMatchObject({ ok: false });
  });
});

describe('a template the page nests must end as it began', () => {
  it.each([
    ['a fragment', '<div><>a <{""}textarea></><b>Hello there</b></div>\n'],
    ['a named fragment', '<div><Fragment>a <{""}textarea></Fragment><b>Hello there</b></div>\n'],
    ['a condition', '<div>{true && <>a <{""}textarea></>}<b>Hello there</b></div>\n'],
    ['a choice', '<div>{true ? <>a <{""}textarea></> : null}<b>Hello there</b></div>\n'],
    ['a list', '<div>{[1].map(() => <>a <{""}textarea></>)}<b>Hello there</b></div>\n'],
    [
      'an element in a condition',
      '<div>{true && <span>a <{""}textarea></span>}<b>Hello there</b></div>\n',
    ],
    ['an attribute left open', '<div>{true && <>a <{""}p title="</>}<b>Hello there</b>"></div>\n'],
    ["a component's children", '<div><Card>a <{""}textarea></Card><b>Hello there</b></div>\n'],
  ])('refuses a word after %s that ends inside markup', async (_name, before) => {
    expect(await edit('Hello', 'Howdy', before)).toMatchObject({ ok: false });
  });

  it('refuses a word after an expression that names the tag a less-than opens', async () => {
    // The browser reads `<script>`; the text a tokenizer sees without the expression is `<>`.
    const before = '<div>{true && <span>a <{"script"}></span>}<b>Hello there</b></div>\n';
    expect(await edit('Hello', 'Howdy', before)).toMatchObject({ ok: false });
  });

  it('refuses a word after one nested template ends on a less-than the next one names', async () => {
    const before = '<div>{true && <>a <</>}{true && <>textarea></>}<b>Hello there</b></div>\n';
    expect(await edit('Hello', 'Howdy', before)).toMatchObject({ ok: false });
  });

  it('refuses a page whose expression prints raw markup inside a condition', async () => {
    const before = '<div>{true ? $$unescapeHTML("<b>") : ""}</div>\n<p>Hello there</p>\n';
    expect(await edit('Hello', 'Howdy', before)).toMatchObject({ ok: false });
  });

  it('still accepts a word after nested templates that close', async () => {
    const before = '<div><span>a</span><><i>b</i></><b>Hello there</b></div>\n';
    expect(await edit('Hello', 'Howdy', before)).toMatchObject({ ok: true });
  });
});

describe('a value the page computes is not taken as text', () => {
  it.each([
    [
      'an object with its own text',
      '<div>{{ toString: () => "<textarea>" }}<b>Hello there</b></div>\n',
    ],
    [
      'a frontmatter value',
      '---\nconst t = { toString: () => "<textarea>" };\n---\n<div>{t}<b>Hello there</b></div>\n',
    ],
    ['a typed array', '<div>{new TextEncoder().encode("<textarea>")}<b>Hello there</b></div>\n'],
    [
      'raw markup by another call form',
      '<div>{(0, $$unescapeHTML)("<textarea>")}<b>Hello there</b></div>\n',
    ],
    [
      'a render tag under another name',
      '---\nconst r = $$render;\nconst x = r`<textarea>`;\n---\n<div>{x}<b>Hello there</b></div>\n',
    ],
    [
      'a component the page defines',
      '---\nconst C = { toString: () => "<textarea>" };\n---\n<div><C /><b>Hello there</b></div>\n',
    ],
    [
      'a component name a parameter shadows',
      '---\nimport Card from "./card.astro";\n---\n<div>{[1].map((Card) => <Card />)}<b>Hello there</b></div>\n',
    ],
  ])('refuses a word after %s', async (_name, before) => {
    expect(await edit('Hello', 'Howdy', before)).toMatchObject({ ok: false });
  });

  it('accepts a word after a literal string and an imported component', async () => {
    const before =
      '---\nimport Card from "./card.astro";\n---\n<div>{"x"}<Card /><b>Hello there</b></div>\n';
    expect(await edit('Hello', 'Howdy', before)).toMatchObject({ ok: true });
  });
});

describe('svg and math, whose text a browser reads by other rules, are refused', () => {
  it.each([
    [
      'a style in an svg',
      '<div><svg><style><p><textarea></style></svg>{""}<b>Hello there</b></div>\n',
    ],
    [
      'a style in an svg in a fragment',
      '<div><><svg><style><title><textarea></style></svg></><b>Hello there</b></div>\n',
    ],
    ['an svg on its own', '<div><svg><g></g></svg><b>Hello there</b></div>\n'],
    ['a math element', '<div><math><mi>x</mi></math><b>Hello there</b></div>\n'],
  ])('%s', async (_name, before) => {
    expect(await edit('Hello', 'Howdy', before)).toMatchObject({ ok: false });
  });
});

describe('a template whose tags the compiler closes late is refused', () => {
  it('refuses a word after a textarea a noscript left open', async () => {
    const before = '<div><noscript><textarea></noscript>{""}<b>Hello there</b></div>\n';
    expect(await edit('Hello', 'Howdy', before)).toMatchObject({ ok: false });
  });
});

describe('a page holding a select is refused', () => {
  it.each([
    ['unclosed, before the word', 'amp', 'copy', '<div><select></div>Fish &<b></b>amp; chips\n'],
    [
      'closed, before the word',
      'Hello',
      'Hi',
      '<select><option>One</option></select>\n<p>Hello there</p>\n',
    ],
    [
      'after the word',
      'Hello',
      'Hi',
      '<p>Hello there</p>\n<select><option>One</option></select>\n',
    ],
  ])('%s', async (_name, word, replacement, before) => {
    expect(await edit(word, replacement, before)).toMatchObject({ ok: false });
  });
});

describe('a word a browser does not show as body copy is refused', () => {
  it.each([
    ['in a template', '<template><p>Hello there</p></template>\n'],
    ['in an svg', '<svg><text>Hello there</text></svg>\n'],
    ['in a table cell', '<table><tr><td>Hello there</td></tr></table>\n'],
    ['in a button', '<button>Hello there</button>\n'],
    ['at the root of the page', 'Hello there\n'],
    ['in a page that prints raw markup', '<div set:html={"<b>"} />\n<p>Hello there</p>\n'],
    [
      'in a page that prints raw markup in another template',
      '<div set:html={"<b>"} />\n<Layout><p>Hello there</p></Layout>\n',
    ],
    ['sharing its text run with a reference', '<p>Hello&amp;there</p>\n'],
    ['in a page the compiler reports an error in', '<p>Hello there</p>\n<Foo client:only />\n'],
    ['after an expression with no tag between', '<p>{"x"} and Hello there</p>\n'],
    ['after a component with no tag between', '<p><Empty /> and Hello there</p>\n'],
    ['after a reference opener in its own run', '<p>Fish &Hello there</p>\n'],
    ['joined to a reference', '<p>&amp;Hello there</p>\n'],
  ])('%s', async (_name, before) => {
    expect(await edit('Hello', 'Hi', before)).toMatchObject({ ok: false });
  });

  it('refuses a page that is not an Astro file, whatever it holds', async () => {
    const [path, before, after] = ['public/a.html', '<p>Hello there</p>\n', '<p>Hi there</p>\n'];
    const target = { path, word: 'Hello', replacement: 'Hi' };
    expect(await checkEnvelope({ files: [{ path, before, after }] }, target)).toMatchObject({
      ok: false,
    });
  });

  it('refuses a word in a script the compiler keeps as text', async () => {
    const before = '<script is:inline>const a = "Hello";</script>\n';
    expect(await edit('Hello', 'Hi', before)).toMatchObject({ ok: false });
  });
});

describe('body copy still passes', () => {
  it.each([
    ['in a paragraph', '<p>Hello there</p>\n'],
    ['after an attribute expression', '<p class={["a"].join("")}>Hello there</p>\n'],
    ['after a tag that follows an expression', '<p>{"x"} <b>and</b> Hello there</p>\n'],
    [
      'in a layout',
      '---\nimport Layout from "./layout.astro";\n---\n<Layout title="x">\n  <section><p>Hello there</p></section>\n</Layout>\n',
    ],
    [
      'under a document of its own',
      '<html><head><title>T</title></head><body><main><p>Hello there</p></main></body></html>\n',
    ],
  ])('%s', async (_name, before) => {
    expect(await edit('Hello', 'Hi', before)).toMatchObject({ ok: true });
  });
});

const module = (word: string) => `const a = $$render\`<p>${word} there</p>\`;\n`;

describe('the compiled modules bind the word', () => {
  const swap = { word: 'Hello', replacement: 'Hi' };

  it('accepts one swap in the printed text', () => {
    expect(swapsOnlyBodyCopy(module('Hello'), module('Hi'), swap)).toBe(true);
  });

  it('refuses modules that differ anywhere else', () => {
    const after = `${module('Hi')}const b = 1;\n`;
    expect(swapsOnlyBodyCopy(module('Hello'), after, swap)).toBe(false);
  });

  it('refuses a swap in a template the runtime does not render', () => {
    const before = 'const a = html`<p>Hello there</p>`;\n';
    expect(swapsOnlyBodyCopy(before, before.replace('Hello', 'Hi'), swap)).toBe(false);
  });

  it('refuses an attribute call that does not land in a tag', () => {
    const before = 'const a = $$render`<p>${$$addAttribute(x, "t")}<b>Hello</b> there</p>`;\n';
    expect(swapsOnlyBodyCopy(before, before.replace('Hello', 'Hi'), swap)).toBe(false);
  });

  it('refuses a module that is not plain JavaScript', () => {
    const before = `${module('Hello')}enum E { A }\n`;
    expect(swapsOnlyBodyCopy(before, before.replace('Hello', 'Hi'), swap)).toBe(false);
  });
});
