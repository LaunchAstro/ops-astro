// SPDX-License-Identifier: AGPL-3.0-only
// The picture holds only where its browser reads the page as the observation did. A policy in the
// page's own markup can drop an inline sheet the observation read, so such a page is refused before
// any browser starts; a sheet's copy is served as UTF-8 only where a browser's order (BOM, header,
// `@charset`, the referrer's encoding) gives UTF-8 for it, and any other sheet fails the picture.
// The browser here is a stand-in that asks for what the route serves, so no Chromium is needed.
import { expect, it } from 'vitest';
import {
  capturePicture,
  type CaptureOptions,
  type PictureBrowser,
} from '../../packages/core-connectors/src/index.ts';
import type { PictureAnswer } from '../../packages/core-connectors/src/capture/picture.ts';
import { importsOf } from '../../packages/core-connectors/src/capture/page.ts';

const PAGE = 'https://www.example.com/about';
const SHEET = 'https://www.example.com/site.css';
const INNER = 'https://www.example.com/inner.css';

function world(html: string, sheets: Record<string, string> = {}): CaptureOptions {
  return {
    pool: { agencyPages: [PAGE], otherPages: [], closedPoolReviews: [] },
    resolve: () => Promise.resolve(['93.184.215.14']),
    transport: (request) => {
      const css = sheets[request.url.href];
      return Promise.resolve({
        kind: 'answer',
        status: 200,
        headers: { 'content-type': css === undefined ? 'text/html; charset=utf-8' : 'text/css' },
        body: new TextEncoder().encode(css ?? html),
      });
    },
  };
}

/** A browser that asks for the document, its linked sheets and every import it is served. */
function standIn(
  links: readonly string[],
  served: PictureAnswer[],
): PictureBrowser & { started: number } {
  const browser = Object.assign(
    async (url: string, route: Parameters<PictureBrowser>[1]) => {
      browser.started += 1;
      const page = await route({ url, kind: 'document', mainFrame: true });
      if (page === null) throw new Error('document refused');
      const queue = [...links];
      for (let href = queue.shift(); href !== undefined; href = queue.shift()) {
        // oxlint-disable-next-line no-await-in-loop -- a browser asks for an import once it reads its parent
        const sheet = await route({ url: href, kind: 'stylesheet', mainFrame: false });
        if (sheet === null) throw new Error('sheet refused');
        served.push(sheet);
        for (const next of importsOf(sheet.body))
          if (next !== undefined) queue.push(new URL(next, href).href);
      }
      return new Uint8Array([1]);
    },
    { started: 0 },
  );
  return browser;
}

it.each([
  ['as written', '<meta http-equiv=Content-Security-Policy content="style-src \'none\'">'],
  ['in capitals', '<META HTTP-EQUIV="CONTENT-SECURITY-POLICY" CONTENT="style-src \'none\'">'],
  [
    'in the body',
    '<p>Hi</p><meta http-equiv="content-security-policy" content="style-src \'none\'">',
  ],
])(
  'a page whose markup declares its own policy %s is refused before the browser starts',
  async (_, policy) => {
    const browser = standIn([], []);
    const picture = await capturePicture(
      PAGE,
      world(`${policy}<style>p{color:red}</style><p>Hello</p>`),
      browser,
    );
    expect({ picture, started: browser.started }).toEqual({
      picture: { ok: false, code: 'CAPTURE_BODY_MALFORMED' },
      started: 0,
    });
  },
);

// A browser applies no sheet of another type, and of titled sets only the preferred one, so
// any of these could leave a sheet the observation read out of the picture with no request missed.
it.each([
  [
    'a policy with no inline sheet',
    '<meta http-equiv=content-security-policy content="img-src \'none\'"><p>Hi</p>',
  ],
  ['a style of another type', '<style type="text/plain">p{color:red}</style><p>Hi</p>'],
  [
    'a style type with parameters',
    '<style type="text/css; charset=utf-8">p{color:red}</style><p>Hi</p>',
  ],
  [
    'titled style sets',
    '<style title="a">p{color:blue}</style><style title="b">p{color:red}</style><p>Hi</p>',
  ],
  [
    'a default style set',
    '<meta http-equiv="Default-Style" content="a"><style>p{color:red}</style><p>Hi</p>',
  ],
  [
    'an SVG style of another type',
    '<svg><style type="text/plain">p{color:red}</style></svg><p>Hi</p>',
  ],
  ['an alternate sheet', '<link rel="alternate stylesheet" href="/site.css"><p>Hi</p>'],
  [
    'a titled sheet',
    '<style title="a">p{}</style><link rel=stylesheet title="b" href="/site.css"><p>Hi</p>',
  ],
])('a page with %s is refused before the browser starts', async (_, page) => {
  const browser = standIn([SHEET], []);
  const picture = await capturePicture(PAGE, world(page, { [SHEET]: 'p{color:red}' }), browser);
  expect({ picture, started: browser.started }).toEqual({
    picture: { ok: false, code: 'CAPTURE_BODY_MALFORMED' },
    started: 0,
  });
});

// A refresh navigates away from the page pictured; a browser honours no other http-equiv that
// changes what it shows, and an unknown one is refused rather than guessed at.
it.each([
  ['a refresh', '<meta http-equiv=refresh content="0"><style>p{color:red}</style><p>Hi</p>'],
  ['a refresh to another page', '<p>Hi</p><meta http-equiv="Refresh" content="0; url=/other">'],
  ['an unknown header', '<meta http-equiv="x-something-new" content="1"><p>Hi</p>'],
])('a page whose markup carries %s is refused before the browser starts', async (_, page) => {
  const browser = standIn([], []);
  const picture = await capturePicture(PAGE, world(page), browser);
  expect({ picture, started: browser.started }).toEqual({
    picture: { ok: false, code: 'CAPTURE_BODY_MALFORMED' },
    started: 0,
  });
});

it.each([
  ['a content type', '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">'],
  ['a content language', '<meta http-equiv="content-language" content="en-AU">'],
  ['an IE compatibility mode', '<meta http-equiv="X-UA-Compatible" content="IE=edge">'],
  ['a DNS prefetch control', '<meta http-equiv="x-dns-prefetch-control" content="on">'],
  [
    'cache headers a browser ignores in markup',
    '<meta http-equiv="Cache-Control" content="no-cache"><meta http-equiv="Pragma" content="no-cache"><meta http-equiv="Expires" content="0">',
  ],
])('a page whose markup carries %s still gets its picture', async (_, meta) => {
  const picture = await capturePicture(PAGE, world(`${meta}<p>Hi</p>`), standIn([], []));
  expect(picture.ok).toBe(true);
});

it.each([
  ['no type', '<style>p{color:red}</style>'],
  ['an empty type', '<style type="">p{color:red}</style>'],
  ['the CSS type in capitals', '<style type="TEXT/CSS">p{color:red}</style>'],
  ['an empty title', '<link rel=stylesheet title="" href="/site.css">'],
])('a sheet with %s, which a browser applies, still gets its picture', async (_, sheet) => {
  const links = sheet.includes('<link') ? [SHEET] : [];
  const picture = await capturePicture(
    PAGE,
    world(`${sheet}<p>Hi</p>`, { [SHEET]: 'p{color:red}' }),
    standIn(links, []),
  );
  expect(picture.ok).toBe(true);
});

it('a report-only markup policy, which blocks nothing, does not refuse the page', async () => {
  const policy =
    '<meta http-equiv=content-security-policy-report-only content="style-src \'none\'">';
  const page = `${policy}<style>p{color:red}</style><p>Hello</p>`;
  expect((await capturePicture(PAGE, world(page), standIn([], []))).ok).toBe(true);
});

const linked = '<link rel=stylesheet href=/site.css><p>Hello</p>';

it.each([
  ['no declaration', '#a{color:red}'],
  ['a UTF-8 declaration', '@charset "utf-8";#a{color:red}'],
  ['a UTF-8 label in capitals', '@charset "UTF-8";#a{color:red}'],
  ['a rule CSS does not read as a declaration', '@CHARSET "windows-1252";#a{color:red}'],
])('a sheet with %s is served as UTF-8', async (_, css) => {
  const served: PictureAnswer[] = [];
  const picture = await capturePicture(
    PAGE,
    world(linked, { [SHEET]: css }),
    standIn([SHEET], served),
  );
  expect(picture.ok).toBe(true);
  expect(served.map((answer) => answer.headers['content-type'])).toEqual([
    'text/css; charset=utf-8',
    'text/css; charset=utf-8',
  ]);
  expect(served[1]?.body).toBe(css);
});

it.each([
  ['another encoding', '@charset "windows-1252";#é{color:red}'],
  ['a UTF-16 label', '@charset "utf-16le";#a{color:red}'],
  ['an unknown label', '@charset "no-such-encoding";#a{color:red}'],
  ['an unclosed declaration', '@charset "windows-1252#a{color:red}'],
  ['a quote inside the label', '@charset "utf"-8";#a{color:red}'],
])('a sheet declaring %s fails the picture', async (_, css) => {
  const served: PictureAnswer[] = [];
  const picture = await capturePicture(
    PAGE,
    world(linked, { [SHEET]: css }),
    standIn([SHEET], served),
  );
  expect(picture).toEqual({ ok: false, code: 'CAPTURE_BODY_MALFORMED' });
  expect(served.map((answer) => answer.body)).not.toContain(css);
});

it('an imported sheet declaring another encoding fails the picture too', async () => {
  const sheets = {
    [SHEET]: '@import "/inner.css";',
    [INNER]: '@charset "windows-1252";#é{color:red}',
  };
  const served: PictureAnswer[] = [];
  const picture = await capturePicture(PAGE, world(linked, sheets), standIn([SHEET], served));
  expect(picture).toEqual({ ok: false, code: 'CAPTURE_BODY_MALFORMED' });
});

// A page the reading admits is pictured or refused by name however wide its tree or its list of
// sheets: no step may hand one call more arguments than the runtime takes.
it('a page with 300,000 sibling elements is pictured, not thrown', async () => {
  const html = `<!doctype html><html><body><p>Hello</p>${'<br>'.repeat(300_000)}</body></html>`;
  const browser = standIn([], []);
  const picture = await capturePicture(PAGE, world(html), browser);
  expect({ ok: picture.ok, started: browser.started }).toEqual({ ok: true, started: 1 });
});

it('a page naming 150,000 sheet imports is refused by name, not thrown', async () => {
  const html = `<style>${'@import"a.css";'.repeat(150_000)}</style><p>Hello</p>`;
  const picture = await capturePicture(PAGE, world(html), standIn([], []));
  expect(picture.ok ? 'pictured' : picture.code).toMatch(/^CAPTURE_[A-Z_]+$/u);
});

// The picture's own look at the markup costs no more than the reading's bounded one: 2 MiB of
// line breaks moved out of a table is linear for the reading, so it is linear here too.
it('a page the reading admits in moments is pictured in moments', async () => {
  const html = `<table>${'<br>'.repeat(524_286)}`;
  const started = performance.now();
  const picture = await capturePicture(PAGE, world(html), standIn([], []));
  const ms = performance.now() - started;
  expect(picture.ok).toBe(true);
  expect(ms).toBeLessThan(5_000);
});
