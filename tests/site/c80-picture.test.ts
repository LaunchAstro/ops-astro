// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 capture picture: what a browser taking the picture may load is decided
// by the product's route, through the fence, and nothing else. A scripted
// browser issues each kind of request a real one would; the real browser's run
// is c80-picture-browser.test.ts.

import { describe, expect, it } from 'vitest';
import {
  PICTURE_POLICY,
  capturePicture,
  type PictureBrowser,
  type PictureRequest,
  type PictureRoute,
} from '../../packages/core-connectors/src/index.ts';
import { ABOUT, PAGE, POOL, SHEET, TRACKER, publicResolver, site } from './c80-picture-world.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** A browser that makes the given requests in order and keeps every answer. */
function scripted(requests: readonly PictureRequest[]) {
  const answers: (Awaited<ReturnType<PictureRoute>> | 'unasked')[] = requests.map(() => 'unasked');
  const browser: PictureBrowser = async (_url, route) => {
    for (const [index, request] of requests.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- a browser's requests, in order
      answers[index] = await route(request);
    }
    return PNG;
  };
  return { browser, answers };
}

const DOCUMENT: PictureRequest = { url: ABOUT, kind: 'document', mainFrame: true };
const STYLESHEET: PictureRequest = { url: SHEET, kind: 'stylesheet', mainFrame: false };
const OTHERS: readonly PictureRequest[] = [
  { url: TRACKER, kind: 'image', mainFrame: false },
  { url: 'https://www.example.com/_astro/app.js', kind: 'script', mainFrame: false },
  { url: 'https://www.example.com/font.woff2', kind: 'font', mainFrame: false },
  { url: ABOUT, kind: 'document', mainFrame: false },
  { url: 'https://www.example.com/team', kind: 'document', mainFrame: true },
];

const options = (transport: ReturnType<typeof site>) => ({
  pool: POOL,
  resolve: publicResolver,
  transport,
});

describe('C80 capture picture', () => {
  it('serves the page through the fence with a policy that runs nothing', async () => {
    const transport = site();
    const { browser, answers } = scripted([DOCUMENT, STYLESHEET]);
    const picture = await capturePicture(ABOUT, options(transport), browser);
    expect(picture).toMatchObject({ ok: true, value: { url: ABOUT, refused: [] } });
    expect(answers[0]).toEqual({
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': PICTURE_POLICY,
      },
      body: PAGE,
    });
    expect(answers[1]).toMatchObject({ headers: { 'content-type': 'text/css' } });
    expect(PICTURE_POLICY).toMatch(/script-src 'none'.*frame-src 'none'/u);
    expect(transport.seen).toEqual([ABOUT, SHEET]);
  });

  it('refuses every other request, recording code and origin only', async () => {
    const transport = site();
    const { browser, answers } = scripted([DOCUMENT, ...OTHERS]);
    const picture = await capturePicture(ABOUT, options(transport), browser);
    expect(answers).toHaveLength(OTHERS.length + 1);
    expect(answers.slice(1).filter((answer) => answer !== null)).toEqual([]);
    expect(transport.seen).toEqual([ABOUT]);
    if (!picture.ok) throw new Error('the picture should be taken');
    expect(picture.value.refused).toHaveLength(OTHERS.length);
    expect(picture.value.refused[0]).toEqual({
      code: 'CAPTURE_KIND_REFUSED',
      hop: 0,
      origin: 'https://tracker.example.net',
    });
    expect(JSON.stringify(picture.value.refused)).not.toMatch(/pixel|visitor|app\.js|woff/u);
  });
});

describe('C80 capture picture, failures', () => {
  it('fails the picture when a stylesheet cannot be fetched', async () => {
    const transport = site(false);
    const { browser } = scripted([DOCUMENT, STYLESHEET]);
    expect(await capturePicture(ABOUT, options(transport), browser)).toEqual({
      ok: false,
      code: 'CAPTURE_STATUS_REFUSED',
    });
  });

  it('refuses an uncatalogued page before anything is fetched', async () => {
    const transport = site();
    const other = 'https://elsewhere.example/about';
    const { browser, answers } = scripted([{ url: other, kind: 'document', mainFrame: true }]);
    expect(await capturePicture(other, options(transport), browser)).toEqual({
      ok: false,
      code: 'CAPTURE_HOST_NOT_CATALOGUED',
    });
    expect([answers[0], transport.seen]).toEqual([null, []]);
  });
});
