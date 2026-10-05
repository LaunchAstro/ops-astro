// SPDX-License-Identifier: AGPL-3.0-only
//
// A page's own code runs when the site builds and renders it, and can change
// what the runtime prints: its escaping, its head, its slots, or the script
// and style the bundler rewrites. A grammar over the printed page cannot see
// that, so the envelope reads the page's source first and accepts only a
// closed shape: imports of other Astro files, then text, comments and
// allow-listed elements and components with quoted literal attributes.

import { describe, expect, it } from 'vitest';
import { checkEnvelope } from '../../packages/core-connectors/src/index.ts';

async function edit(before: string, path = 'src/pages/a.astro') {
  const after = before.replace('Hello', 'Howdy');
  const target = { path, word: 'Hello', replacement: 'Howdy' };
  return await checkEnvelope({ files: [{ path, before, after }] }, target);
}

const PAGE_IN_HTML = (frontmatter: string, attribute = '') =>
  `---\n${frontmatter}\n---\n<html><head><title>x</title></head><body><p${attribute}>Hello there</p></body></html>\n`;
const CARD = 'import Card from "./Card.astro";';

describe("a page's own code that steers the runtime is refused", () => {
  it.each([
    [
      'frontmatter that turns off escaping',
      '---\nRegExp.prototype.test = () => false;\n---\n<div>{"<textarea>"}<b>Hello there</b></div>\n',
    ],
    [
      'frontmatter that writes the head',
      PAGE_IN_HTML("$$result._metadata.extraHead.push('<textarea>');"),
    ],
    [
      'frontmatter that adds a style',
      PAGE_IN_HTML("$$result.styles.add({ props: {}, children: '</style><textarea>' });"),
    ],
    [
      'frontmatter that replaces a slot',
      "---\n$$slots.default = () => ({ toString: () => '<textarea>' });\n---\n<div><slot /><b>Hello there</b></div>\n",
    ],
    ['frontmatter that declares a value', PAGE_IN_HTML(`${CARD}\nexport const prerender = true;`)],
    [
      'an attribute that turns off escaping',
      '<div title={(RegExp.prototype.test = () => false, "a")}>{"<textarea>"}<b>Hello there</b></div>\n',
    ],
    [
      'an attribute that writes the head',
      PAGE_IN_HTML('', ' title={($$result._metadata.extraHead.push("<textarea>"), "a")}'),
    ],
    [
      'a prop whose getter turns off escaping',
      `---\n${CARD}\n---\n<Card a={{ get b() { RegExp.prototype.test = () => false; return 1; } }.b} />{"<textarea>"}<b>Hello there</b>\n`,
    ],
    ['a spread attribute', PAGE_IN_HTML('', ' {...{ title: "a" }}')],
    ['a shorthand attribute', PAGE_IN_HTML('', ' {Card}')],
    ['a template-literal attribute', PAGE_IN_HTML('', ' title=`a`')],
    ['a directive', PAGE_IN_HTML('', ' set:html="<textarea>"')],
    ['a slot attribute', `---\n${CARD}\n---\n<Card><p slot="a">Hello there</p></Card>\n`],
    ['an expression in the body', '<div>{"a"}<b>Hello there</b></div>\n'],
    [
      'a fragment passed as a slot',
      `---\n${CARD}\n---\n<Card><Fragment slot="a"><p>Hello there</p></Fragment></Card>\n`,
    ],
  ])('refuses %s', async (_name, before) => {
    expect(await edit(before)).toMatchObject({ ok: false });
  });
});

describe('a component the page writes itself is refused', () => {
  it.each([
    [
      'a data URL import',
      '---\nimport X from "data:text/javascript;base64,ZXhwb3J0IGRlZmF1bHQgT2JqZWN0LmFzc2lnbigoKSA9PiAiPHRleHRhcmVhPiIsIHsiYXN0cm86aHRtbCI6IHRydWV9KTs=";\n---\n<div><X /><b>Hello there</b></div>\n',
    ],
    [
      "the runtime's raw-markup helper",
      '---\nimport { unescapeHTML as U } from "astro/runtime/server/index.js";\n---\n<div><U /><b>Hello there</b></div>\n',
    ],
    [
      'a package import',
      '---\nimport X from "astro-raw/index.astro";\n---\n<div><X /><b>Hello there</b></div>\n',
    ],
    [
      'an Astro file read as a string',
      '---\nimport X from "./x.astro?raw&.astro";\n---\n<div><X /><b>Hello there</b></div>\n',
    ],
    [
      'a namespace import',
      '---\nimport * as X from "./Card.astro";\n---\n<div><X /><b>Hello there</b></div>\n',
    ],
    [
      'an import with attributes',
      '---\nimport X from "./Card.astro" with { type: "json" };\n---\n<div><X /><b>Hello there</b></div>\n',
    ],
    [
      'the page itself',
      '---\nimport Self from "./a.astro";\n---\n<div><Self /><b>Hello there</b></div>\n',
    ],
    [
      'the page itself, by another spelling',
      '---\nimport Self from "../pages/./A.astro";\n---\n<div><Self /><b>Hello there</b></div>\n',
    ],
  ])('refuses %s', async (_name, before) => {
    expect(await edit(before)).toMatchObject({ ok: false });
  });
});

describe("the page's own script and style are refused", () => {
  it.each([
    [
      'a script the minifier folds into markup',
      '<div><script>console.log("<!-" + "-<scr" + "ipt>");</script><p>Hello there</p></div>\n',
    ],
    [
      'a script in the head',
      '<html><head><title>x</title><script>console.log("<!-" + "-<scr" + "ipt>");</script></head><body><p>Hello there</p></body></html>\n',
    ],
    [
      'a style the minifier unescapes',
      '<html><head><title>x</title></head><body><p>Hello there</p></body></html>\n<style>p::after { content: "\\3c/style>\\3ctextarea>"; }</style>\n',
    ],
    [
      'a style on a page with no html element',
      '<p>Hello there</p>\n<style>p::after { content: "\\3c/style>\\3ctextarea>"; }</style>\n',
    ],
  ])('refuses %s', async (_name, before) => {
    expect(await edit(before)).toMatchObject({ ok: false });
  });
});

describe('a page of content in other Astro files still passes', () => {
  it.each([
    [
      'in a layout',
      `---\n${CARD}\n---\n<Card title="Home" wide><p class="lead">Hello there</p></Card>\n`,
    ],
    [
      'in a whole document',
      PAGE_IN_HTML(`${CARD}\nimport Footer from "../components/Footer.astro";`),
    ],
    ['with no frontmatter', '<main><h1>Title</h1><!-- note --><p>Hello there</p></main>\n'],
    ['in fragments', '<div><><i>a</i></><Fragment><b>Hello there</b></Fragment></div>\n'],
  ])('accepts a word %s', async (_name, before) => {
    expect(await edit(before)).toMatchObject({ ok: true });
  });
});

// Stage 1's limit: these pages are body copy, but the page runs code of its
// own, so the edit goes to a person. A check of the rendered page, built in
// a sandbox, is the follow-up that would widen this.
describe('pages with code of their own go to a person, body copy or not', () => {
  it.each([
    ['after an attribute expression', '<p class={["a"].join("")}>Hello there</p>\n'],
    ['after a tag that follows an expression', '<p>{"x"} <b>and</b> Hello there</p>\n'],
    ['after a closed expression holding a quoted brace', "<p>{'}'}<br />Hello there</p>\n"],
    [
      'under typed frontmatter',
      '---\ninterface Props { a: string }\nconst { a } = Astro.props as Props;\n---\n<p title={a}>Hello there</p>\n',
    ],
    ['in an is:raw element', '<pre is:raw>Hello there</pre>\n'],
    ['beside a style of its own', '<p>Hello there</p>\n<style>p { color: red; }</style>\n'],
  ])('refuses a word %s', async (_name, before) => {
    expect(await edit(before)).toMatchObject({ ok: false });
  });
});
