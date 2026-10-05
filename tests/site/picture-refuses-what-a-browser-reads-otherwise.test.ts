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

it('a markup policy over a page with no inline sheet still gets its picture', async () => {
  const policy = '<meta http-equiv=content-security-policy content="img-src \'none\'">';
  const picture = await capturePicture(PAGE, world(`${policy}<p>Hello</p>`), standIn([], []));
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
