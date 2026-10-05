// SPDX-License-Identifier: AGPL-3.0-only
// A shallow page the reading admits, with very many sibling elements, gives a Fenced result
// rather than reject capturePicture.
import { expect, it } from 'vitest';
import {
  capturePicture,
  type CaptureOptions,
  type PictureBrowser,
} from '../../packages/core-connectors/src/index.ts';
import { readDocument } from '../../packages/core-connectors/src/capture/page.ts';

const PAGE = 'https://www.example.com/about';

it('a wide admitted page resolves to a Fenced result', async () => {
  const html = `<!doctype html><html><body><p>Hello</p>${'<br>'.repeat(300_000)}</body></html>`;
  expect(typeof readDocument(html)).not.toBe('string');
  const options: CaptureOptions = {
    pool: { agencyPages: [PAGE], otherPages: [], closedPoolReviews: [] },
    resolve: () => Promise.resolve(['93.184.215.14']),
    transport: () =>
      Promise.resolve({
        kind: 'answer',
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: new TextEncoder().encode(html),
      }),
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- the reviewer's proof, kept as written
  const browser: PictureBrowser = async (url, route) => {
    const page = await route({ url, kind: 'document', mainFrame: true });
    if (page === null) throw new Error('document refused');
    return new Uint8Array([1]);
  };
  await expect(capturePicture(PAGE, options, browser)).resolves.toHaveProperty('ok');
}, 60_000);
