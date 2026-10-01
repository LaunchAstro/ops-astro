// SPDX-License-Identifier: AGPL-3.0-only
//
// `S0-6 content policy` in a real browser: the built page, served with an
// inline script and an outside script planted in it, runs its own bundle and
// neither plant. `tests/api/session-cookie-tabs.test.ts` reads the policy out
// of the page; this run is the evidence that a browser enforces it, required
// through `built-page-refuses-planted-scripts.test.ts` in CI's own step.
//
// Run after `pnpm build`: `node tests/browser/content-policy.mjs`. It serves
// `apps/web/dist` on a loopback port of its own and closes it, and answers
// `/api/sign-in` as the API would, since the page asks it before drawing the form.

import { readFileSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { extname, resolve as resolvePath, sep } from 'node:path';
import { chromium } from 'playwright';

const DIST = resolvePath(import.meta.dirname, '../../apps/web/dist');
const PLANTED = [
  '<script>window.plantedInline = true;</script>',
  '<script src="OUTSIDE/planted.js"></script>',
  '<img src="x" onerror="window.plantedHandler = true">',
].join('');

// Another origin that would serve the outside script, so a refusal is the
// policy's and not a failed fetch.
const outside = createServer((_request, response) => {
  response
    .writeHead(200, { 'content-type': 'text/javascript' })
    .end('window.plantedOutside = true;');
});
await new Promise((resolve) => {
  outside.listen(0, '127.0.0.1', resolve);
});
const OUTSIDE = `http://127.0.0.1:${String(outside.address().port)}`;

const server = createServer((request, response) => {
  if (request.url === '/api/sign-in') {
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ issuer: 'http://127.0.0.1:9/auth/v1' }));
    return;
  }
  const path = request.url === '/' ? '/index.html' : (request.url ?? '/');
  const file = resolvePath(DIST, `.${path}`);
  if (!file.startsWith(`${DIST}${sep}`)) {
    response.writeHead(404).end();
    return;
  }
  try {
    let body = readFileSync(file);
    if (path === '/index.html') {
      body = Buffer.from(
        String(body).replace(
          '<div id="app"></div>',
          `<div id="app"></div>${PLANTED.replace('OUTSIDE', OUTSIDE)}`,
        ),
      );
    }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[
      extname(path)
    ];
    response.writeHead(200, { 'content-type': type ?? 'application/octet-stream' }).end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', resolve);
});
const origin = `http://127.0.0.1:${String(server.address().port)}`;

// The page server hands out files under `dist` only: a path that climbs out
// of it is refused.
const status = (path) =>
  new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port: server.address().port, path }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
const climbed = [
  await status('/../../../package.json'),
  await status('/assets/../../../../package.json'),
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const refused = [];
  page.on('console', (message) => {
    if (/Content Security Policy/u.test(message.text())) refused.push(message.text());
  });
  await page.goto(`${origin}/`);
  await page.waitForSelector('#signin-email', { timeout: 15_000 });
  const ran = await page.evaluate(() => ({
    inline: window.plantedInline === true,
    handler: window.plantedHandler === true,
    outside: window.plantedOutside === true,
    ownBundle: document.querySelector('#app')?.children.length ?? 0,
  }));
  const rows = [
    ['the page’s own bundle runs', ran.ownBundle > 0],
    ['a planted inline script does not run', !ran.inline],
    ['a planted inline handler does not run', !ran.handler],
    ['a planted outside script does not run', !ran.outside],
    ['the browser reports the refusals', refused.length >= 2],
    ['a path outside the built page is not served', climbed.every((code) => code === 404)],
  ];
  for (const [line, held] of rows) console.log(`${held ? 'PASS' : 'FAIL'}  ${line}`);
  console.log(`refusals reported: ${String(refused.length)}`);
  console.log(`outside paths answered: ${climbed.join(', ')}`);
  process.exitCode = rows.every(([, held]) => held) ? 0 : 1;
} finally {
  await browser.close();
  server.close();
  outside.close();
}
