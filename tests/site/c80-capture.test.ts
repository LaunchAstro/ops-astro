// SPDX-License-Identifier: AGPL-3.0-only
//
// C80: one fenced capture of a page is the observation Receipt L's fields 9
// to 12 compare: the visible text, the document's digest, and every served
// stylesheet's digest, each fetched through the fence. A stylesheet that
// cannot be fetched fails the capture rather than dropping out of the
// comparison.

import { describe, expect, it } from 'vitest';
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

function answer(type: string, body: string): TransportAnswer {
  return {
    kind: 'answer',
    status: 200,
    headers: { 'content-type': type },
    body: new TextEncoder().encode(body),
  };
}

function site(pages: Record<string, TransportAnswer>): Transport & { seen: string[] } {
  const seen: string[] = [];
  const missing: TransportAnswer = {
    kind: 'answer',
    status: 404,
    headers: {},
    body: new Uint8Array(),
  };
  const transport = (request: TransportRequest) => {
    seen.push(request.url.href);
    return Promise.resolve(pages[request.url.href] ?? missing);
  };
  return Object.assign(transport, { seen });
}

const publicResolver = () => Promise.resolve(['93.184.215.14']);

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
          [ABOUT]: answer('text/html', '<link rel="stylesheet" href="/a.css"><p>x</p>'),
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

describe('C80 one word only (the fenced capture it compares)', () => {
  it.each([
    [
      'another host',
      '<link rel="stylesheet" href="https://cdn.example.net/a.css">',
      'CAPTURE_HOST_NOT_CATALOGUED',
    ],
    [
      'the metadata address',
      '<link rel="stylesheet" href="http://169.254.169.254/a.css">',
      'CAPTURE_HOST_NOT_CATALOGUED',
    ],
    [
      'a missing stylesheet',
      '<link rel="stylesheet" href="/missing.css">',
      'CAPTURE_STATUS_REFUSED',
    ],
    [
      'single quotes and odd case',
      "<LINK REL='StyleSheet' HREF='https://cdn.example.net/a.css'>",
      'CAPTURE_HOST_NOT_CATALOGUED',
    ],
  ])(
    'fails the whole capture on %s, rather than dropping it from the comparison',
    async (_name, link, code) => {
      const result = await capturePage(ABOUT, {
        pool: POOL,
        resolve: publicResolver,
        transport: site({ [ABOUT]: answer('text/html', `${link}<p>x</p>`) }),
      });
      expect(result).toMatchObject({ ok: false, code });
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
      const result = await capturePage(ABOUT, {
        pool: POOL,
        resolve: publicResolver,
        transport: site({ [ABOUT]: answer('text/html', body) }),
      });
      expect(result).toMatchObject({ ok: true });
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
    const result = await capturePage(ABOUT, {
      pool: POOL,
      resolve: publicResolver,
      transport: site({ [ABOUT]: answer('text/html', body) }),
    });
    expect(result.ok || result.code === 'CAPTURE_BODY_MALFORMED').toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('C80 the fenced capture: a page nested deep', () => {
  // Ruling P25PARSER: a browser's tree builder walks its open elements, so deep nesting costs
  // depth times tags; past a depth no real page reaches, the capture refuses at once.
  it.each(['<div>', '<ul><li>'])(
    'refuses 100,000 nested %s as oversized within a second',
    async (opener) => {
      const started = performance.now();
      const result = await capturePage(ABOUT, {
        pool: POOL,
        resolve: publicResolver,
        transport: site({ [ABOUT]: answer('text/html', `<p>x</p>${opener.repeat(100_000)}`) }),
      });
      expect(result).toEqual({ ok: false, code: 'CAPTURE_OVERSIZED' });
      expect(performance.now() - started).toBeLessThan(1000);
    },
  );
});

// Security review of P25, low 3, re-reported by the second re-bind: the capture read some
// markup differently from a browser, so a region could hide visible text or a loaded sheet.
// Each region follows `<p>Base</p>`; what a browser reads was checked against parse5.
const EVIL = 'https://www.example.com/evil.css';
const ASSETS = 'https://www.example.com/assets/evil.css';
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

const captured = (body: string) =>
  capturePage(ABOUT, {
    pool: POOL,
    resolve: publicResolver,
    transport: site({
      [ABOUT]: answer('text/html', body),
      [EVIL]: answer('text/css', 'p{display:none}'),
      [ASSETS]: answer('text/css', 'p{display:none}'),
    }),
  });

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

// The fourth re-bind, finding 1: a second <html> or <body> merges its attributes onto the first,
// checking each against every name the first holds, so distinct names piled up past the per-tag
// bound and a 2 MiB page took about 18 minutes.
const merging = (tag: string): string => {
  const named: string[] = [];
  for (let size = 0, at = 0; size < 1020 * 1024; at += 250) {
    named.push(`<${tag}${Array.from({ length: 250 }, (_, n) => ` a${at + n}`).join('')}>`);
    size += named.at(-1)?.length ?? 0;
  }
  const head = named.join('');
  return head + `<${tag}>`.repeat(Math.floor((2040 * 1024 - head.length) / (tag.length + 2)));
};

describe('C80 the fenced capture: attributes merged onto one element', () => {
  it.each(['html', 'body'])(
    'refuses a 2 MiB page of <%s> tags with distinct attributes as oversized within a second',
    async (tag) => {
      const started = performance.now();
      expect(await captured(merging(tag))).toEqual({ ok: false, code: 'CAPTURE_OVERSIZED' });
      expect(performance.now() - started).toBeLessThan(1000);
    },
  );
});
