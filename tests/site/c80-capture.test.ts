// SPDX-License-Identifier: AGPL-3.0-only
//
// C80: one fenced capture of a page is the observation Receipt L's fields 9
// to 12 compare: the visible text, the document's digest, and every served
// stylesheet's digest, each fetched through the fence. A stylesheet that
// cannot be fetched fails the capture rather than dropping out of the
// comparison.

import { Parser, Tokenizer, defaultTreeAdapter } from 'parse5';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  capturePage,
  type CapturePool,
  type Transport,
  type TransportAnswer,
  type TransportRequest,
} from '../../packages/core-connectors/src/index.ts';

const ABOUT = 'https://www.example.com/about';
const POOL: CapturePool = { agencyPages: [ABOUT], otherPages: [], closedPoolReviews: [] };

const PAGE = `<!doctype html><html><head>
<link rel="stylesheet" href="/_astro/site.css">
<link rel="preload stylesheet" href="https://www.example.com/_astro/extra.css">
<link rel="icon" href="/favicon.svg">
<style>p{margin:0}</style>
<script>var alongside = 1;</script>
</head><body>
<!-- alongside in a comment -->
<p>We walk alongside you &amp; your team&#x2e;&#99999999;</p>
<noscript>alongside</noscript>
</body></html>`;

const answer = (type: string, body: string, status = 200): TransportAnswer => ({
  kind: 'answer',
  status,
  headers: { 'content-type': type },
  body: new TextEncoder().encode(body),
});

function site(pages: Record<string, TransportAnswer>): Transport & { seen: string[] } {
  const seen: string[] = [];
  const missing = answer('', '', 404);
  const transport = (request: TransportRequest) => {
    seen.push(request.url.href);
    return Promise.resolve(pages[request.url.href] ?? missing);
  };
  return Object.assign(transport, { seen });
}

const publicResolver = () => Promise.resolve(['93.184.215.14']);
const EVIL = 'https://www.example.com/evil.css';
const ASSETS = 'https://www.example.com/assets/evil.css';
const captured = (body: string) =>
  capturePage(ABOUT, {
    pool: POOL,
    resolve: publicResolver,
    transport: site({
      [ABOUT]: answer('text/html; charset=utf-8', body),
      [EVIL]: answer('text/css', 'p{display:none}'),
      [ASSETS]: answer('text/css', 'p{display:none}'),
    }),
  });

describe('C80 one word only (the fenced capture it compares)', () => {
  it('observes the visible text, the document digest and every served stylesheet through the fence', async () => {
    const transport = site({
      [ABOUT]: answer('text/html; charset=utf-8', PAGE),
      'https://www.example.com/_astro/site.css': answer('text/css', 'p{color:#111}'),
      'https://www.example.com/_astro/extra.css': answer('text/css', 'h1{}'),
    });
    const result = await capturePage(ABOUT, { pool: POOL, resolve: publicResolver, transport });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe('We walk alongside you & your team.\uFFFD');
    expect(result.value.documentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.keys(result.value.stylesheets)).toEqual([
      'https://www.example.com/_astro/extra.css',
      'https://www.example.com/_astro/site.css',
      'inline:0',
    ]);
    expect(transport.seen).not.toContain('https://www.example.com/favicon.svg');
  });

  it('changes a stylesheet digest when its served bytes change', async () => {
    const capture = (css: string) =>
      capturePage(ABOUT, {
        pool: POOL,
        resolve: publicResolver,
        transport: site({
          [ABOUT]: answer('text/html; charset=utf-8', '<link rel=stylesheet href=/a.css><p>x</p>'),
          'https://www.example.com/a.css': answer('text/css', css),
        }),
      });
    const [one, two] = await Promise.all([capture('p{}'), capture('p{color:red}')]);
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(one.value.stylesheets['https://www.example.com/a.css']).not.toBe(
      two.value.stylesheets['https://www.example.com/a.css'],
    );
  });
});

const [HOST, STATUS] = ['CAPTURE_HOST_NOT_CATALOGUED', 'CAPTURE_STATUS_REFUSED'];
const OVERSIZED = 'CAPTURE_OVERSIZED';

describe('C80 one word only (the fenced capture it compares)', () => {
  it.each([
    ['another host', '<link rel="stylesheet" href="https://cdn.example.net/a.css">', HOST],
    ['the metadata address', '<link rel="stylesheet" href="http://169.254.169.254/a.css">', HOST],
    ['a missing stylesheet', '<link rel="stylesheet" href="/missing.css">', STATUS],
    [
      'single quotes and odd case',
      "<LINK REL='StyleSheet' HREF='https://cdn.example.net/a.css'>",
      HOST,
    ],
  ])(
    'fails the whole capture on %s, rather than dropping it from the comparison',
    async (_name, link, code) => {
      expect(await captured(`${link}<p>x</p>`)).toMatchObject({ ok: false, code });
    },
  );

  it('refuses a page outside the catalogue before any request', async () => {
    const transport = site({});
    expect(
      await capturePage('https://www.example.com/contact', {
        pool: POOL,
        resolve: publicResolver,
        transport,
      }),
    ).toMatchObject({ ok: false, code: 'CAPTURE_HOST_NOT_CATALOGUED' });
    expect(transport.seen).toHaveLength(0);
  });
});

describe('C80 the fenced capture: a page that never closes', () => {
  // Security review of P25, finding 1: an opener with no closer after it made
  // each scan restart at every opener, so a 2 MiB page froze the worker for
  // minutes after the fence's deadline had stopped counting.
  it.each([
    ['comments', '<!--', ''],
    ['scripts', '<script ', ''],
    ['scripts, but for a near spelling of the closer,', '<script ', '</scriptx>'],
    ['styles', '<style ', ''],
    ['links', '<link ', ''],
    ['tags', '<a ', ''],
  ])(
    'reads a page whose %s never close as a browser does, without scanning it opener by opener',
    async (_name, opener, tail) => {
      const body = `<p>x</p>${opener.repeat(Math.floor((256 * 1024) / opener.length))}${tail}`;
      const started = performance.now();
      expect(await captured(body)).toMatchObject({ ok: true });
      expect(performance.now() - started).toBeLessThan(1000);
    },
  );

  // The re-bound review of P25: a guard over the original document did not
  // hold, since each regex pass ran over the previous pass's output and the
  // scans folded U+017F to s. Each body below answers at once, whatever it answers.
  it.each([
    ['tag openers whose only closer sits in a comment', '<', '<!-- > -->'],
    ['tag openers whose only closer sits in a script', '<', '<script>></script>'],
    ['scripts whose only closer sits in a comment', '<script>', '<!--</script>-->'],
    ['styles spelt with a long s', '<\u017Ftyle>', ''],
    ['scripts spelt with a long s', '<\u017Fcript>', ''],
  ])('answers a page of %s within a second', async (_name, opener, tail) => {
    const body = `<p>x</p>${opener.repeat(Math.floor((256 * 1024) / opener.length))}${tail}`;
    const started = performance.now();
    const result = await captured(body);
    expect(result.ok || result.code === 'CAPTURE_BODY_MALFORMED').toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

// Security review of P25, low 3, re-reported by the second re-bind: the capture read some
// markup differently from a browser, so a region could hide visible text or a loaded sheet.
// Each region follows `<p>Base</p>`; what a browser reads was checked against parse5.
const R = '<p>SHOWN</p><link rel=stylesheet href=/evil.css>';
const AS_A_BROWSER_READS: readonly (readonly [string, string, readonly string[]])[] = [
  ['<!-->SHOWN<!-- -->', 'Base SHOWN', []],
  ['<!--->SHOWN<!-- -->', 'Base SHOWN', []],
  ['<!-- x --!>SHOWN<!-- -->', 'Base SHOWN', []],
  ['<script>x</script x>SHOWN<script>y</script>', 'Base SHOWN', []],
  ['<script>x</script/>SHOWN<script>y</script>', 'Base SHOWN', []],
  ['<script.x>SHOWN</script.x><script></script>', 'Base SHOWN', []],
  ['<style:x>SHOWN</style:x><style>p{}</style>', 'Base SHOWN', ['inline:0']],
  ['<link/rel="stylesheet"/href="/evil.css">', 'Base', [EVIL]],
  ['<link/rel=stylesheet/href=evil.css>', 'Base', []],
  ['<a title="><!--">SHOWN</a><!-- -->', 'Base SHOWN', []],
  ['<a title="><!--"><link rel=stylesheet href=/evil.css><!-- -->', 'Base', [EVIL]],
  ['<link rel="&#115tylesheet" href="/evil&#46;css">', 'Base', [EVIL]],
  ['<link rel="x&Tab;stylesheet" href="/evil&#x2E;css">', 'Base', [EVIL]],
  ['<!--<base href=/no/>--><base href=/assets/><base href=/later/>', 'Base', []],
  ['<base href=/assets/><link rel=stylesheet href=evil.css>', 'Base', [ASSETS]],
  ['<xmp><!--</xmp>SHOWN<!-- -->', 'Base <!-- SHOWN', []],
  ['<textarea><!--</textarea>SHOWN<!-- -->', 'Base <!-- SHOWN', []],
  ['<title><!--</title>SHOWN<!-- -->', 'Base <!-- SHOWN', []],
  ['<iframe><!--</iframe>SHOWN<!-- -->', 'Base SHOWN', []],
  ['<noembed><!--</noembed>SHOWN<!-- -->', 'Base SHOWN', []],
  ['<noframes><!--</noframes>SHOWN<!-- -->', 'Base SHOWN', []],
  ['<plaintext><!--</plaintext>SHOWN-->', 'Base <!--</plaintext>SHOWN-->', []],
  // The third re-bind, findings 1 and 2: foreign content, CDATA, script escapes and template
  // contents left the capture inside a hidden element, and an svg <base> moved its links.
  [`<svg><iframe></svg>${R}</iframe>`, 'Base SHOWN', [EVIL]],
  [`<svg><script></svg>${R}<title></script></title>`, 'Base SHOWN </script>', [EVIL]],
  [`<math><noembed>${R}</noembed></math>`, 'Base SHOWN', [EVIL]],
  [`<svg><![CDATA[><noscript>]]></svg>${R}</noscript>`, 'Base ><noscript> SHOWN', [EVIL]],
  [`<script><!--<script></script><iframe></script>${R}</iframe>`, 'Base SHOWN', [EVIL]],
  [`<template><!--</template><iframe>--></template>${R}</iframe>`, 'Base SHOWN', [EVIL]],
  ['<svg><base href=/assets/></svg><link rel=stylesheet href=evil.css>', 'Base', [EVIL]],
  ['<svg><style>p{}</style></svg><template><style>q{}</style></template>', 'Base', ['inline:0']],
];

describe('C80 the fenced capture reads a page as a browser does', () => {
  it.each(AS_A_BROWSER_READS)('reads <p>Base</p>%s', async (region, text, sheets) => {
    const result = await captured(`<p>Base</p>${region}`);
    expect(result).toMatchObject({ ok: true, value: { text } });
    if (result.ok) expect(Object.keys(result.value.stylesheets)).toEqual(sheets);
  });

  it('reads a stylesheet address holding any named reference as a browser does', async () => {
    const result = await captured('<link rel=stylesheet href="/evil&period;css"><p>x</p>');
    expect(result.ok && Object.keys(result.value.stylesheets)).toEqual([EVIL]);
  });

  it('captures two spellings a browser shows differently as different text', async () => {
    for (const [one, two] of [
      ['&lt;', '&Lt;'],
      ['\u0080', '&#x80;'],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- two captures per pair, in turn
      const [left, right] = [await captured(`<p>${one}</p>`), await captured(`<p>${two}</p>`)];
      expect(left.ok && right.ok && left.value.text !== right.value.text, `${one} ${two}`).toBe(
        true,
      );
    }
  });
});

// The fourth re-bind, finding 2: a declarative shadow root or a srcdoc frame shows text and loads
// sheets the capture never reads, so a page carrying one is refused rather than read in part.
describe('C80 the fenced capture: what a browser renders that it cannot read', () => {
  it.each([
    `<p>Base</p><div><template shadowrootmode=open>${R}</template></div>`,
    '<div><template shadowrootmode=open><p>NEW</p></template><p>Base rest of page</p></div>',
    `<p>Base</p><iframe srcdoc="${R}"></iframe>`,
    `<p>Base</p><div><template shadowroot=closed>${R}</template></div>`,
  ])('refuses %s as malformed', async (body) => {
    expect(await captured(body)).toEqual({ ok: false, code: 'CAPTURE_BODY_MALFORMED' });
  });
});

// The parser bounds. Ruling P25PARSER: a browser's tree builder walks its open elements, so deep
// nesting costs depth times tags. The fourth re-bind, findings 1 and 4: each later <html> or <body>
// merged its attributes onto the first, checking every name held (18 minutes at 2 MiB), and three
// bounds had no row though each leans on parse5's internals. Each row answers within a second.
const named = (count: number, from = 0): string =>
  Array.from({ length: count }, (_, at) => ` a${from + at}`).join('');
const repeated = (head: string, tail: string): string =>
  head + tail.repeat(Math.floor((2040 * 1024 - head.length) / tail.length));
const merging = (tag: string): string => {
  let head = '';
  for (let at = 0; head.length < 1020 * 1024; at += 250) head += `<${tag}${named(250, at)}>`;
  return repeated(head, `<${tag}>`);
};

describe('C80 the fenced capture: the parser bounds', () => {
  it.each([
    ['100,000 nested <div>', () => `<p>x</p>${'<div>'.repeat(100_000)}`, OVERSIZED],
    ['100,000 nested <ul><li>', () => `<p>x</p>${'<ul><li>'.repeat(100_000)}`, OVERSIZED],
    ['<html> tags of distinct attributes', () => merging('html'), OVERSIZED],
    ['<body> tags of distinct attributes', () => merging('body'), OVERSIZED],
    ['one tag of distinct attributes', () => `<p${named(250_000)}>`, OVERSIZED],
    ['<template><td></template>', () => repeated('', '<template><td></template>'), OVERSIZED],
    ['<a><table><a>', () => repeated('', '<a><table><a>'), 'ok'],
    ['one tag of 256 distinct attributes', () => `<p${named(256)}>x</p>`, 'ok'],
    ['one tag of 257', () => `<p${named(257)}>x</p>`, OVERSIZED],
  ])('answers a page of %s within a second', async (_name, body, expected) => {
    const started = performance.now();
    const result = await captured(body());
    expect(result.ok ? 'ok' : result.code).toBe(expected);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  // The bounds lean on parse5's internals, so the capture refuses to load where one has moved.
  it.each([
    ['a tokenizer without _leaveAttrName', Tokenizer.prototype, '_leaveAttrName', undefined],
    ['a tree adapter without insertBefore', defaultTreeAdapter, 'insertBefore', undefined],
    ['a parser that tells the adapter of no push', Parser.prototype, 'onItemPush', () => null],
  ])('refuses to load over %s', async (_name, owner, member, value) => {
    const kept = Object.getOwnPropertyDescriptor(owner, member) ?? {};
    Object.defineProperty(owner, member, { value, configurable: true, writable: true });
    onTestFinished(() => void Object.defineProperty(owner, member, kept));
    vi.resetModules();
    await expect(import('../../packages/core-connectors/src/capture/page.ts')).rejects.toThrow(
      /parse5/u,
    );
  });
});
