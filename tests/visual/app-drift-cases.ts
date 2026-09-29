// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
//
// The app-only drift mode's own cases, in the pinned headless shell against a
// made-up page served on a local port (the `visual drift` job runs them before
// the mode itself; a browser is needed, so they are not in `pnpm test`):
//
//   node tests/visual/app-drift-cases.ts
//
// 1. dark drift on a page with a dark theme: every line passes, and the shift
//    and the token change each fail their capture;
// 2. the same page with no dark theme, asked for dark: refused;
// 3. a token the page never sets: refused (a change that draws nothing proves nothing);
// 4. a session file: its entry is in the page's sessionStorage before the page's
//    own script runs, and never in localStorage (MP-1-7 criterion 5).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { appDrift } from './app-drift.ts';
import { openSide } from './capture.ts';
import { MODE, readPacket } from './packet.ts';

const DARK = `@media (prefers-color-scheme: dark){:root{--text:#e6e9f0;--surface:#11151c}}`;
const page = (dark: boolean): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--text:#1d2433;--surface:#ffffff}${dark ? DARK : ''}
body{margin:0;background:var(--surface);color:var(--text);font:16px "Funnel Sans"}
.go{display:inline-block;margin:40px;padding:10px 20px;background:var(--text);color:var(--surface)}
</style></head><body><p>Made-up words for a made-up page.</p><span class="go">Go</span>
<p id="held"></p><script>
document.getElementById('held').textContent = sessionStorage.getItem('ops-astro.session') ?? 'signed out';
</script></body></html>`;

const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(page(request.url !== '/no-dark'));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const app = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
const out = mkdtempSync(join(tmpdir(), 'app-drift-cases-'));
const failures: string[] = [];
const expect = (ok: boolean, what: string): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

async function run(address: string, token: string, theme: 'light' | 'dark') {
  const lines: { line: string; fails: boolean }[] = [];
  const drift = { label: `case${address}`, address, control: '.go', token, theme };
  await appDrift({
    app,
    drift,
    mask: [],
    out,
    say: (line, fails = false) => {
      lines.push({ line, fails });
    },
  });
  return lines;
}

try {
  const widths = readPacket().widths.length;
  const dark = await run('/', '--text', 'dark');
  expect(
    dark.every((one) => !one.fails),
    `1. dark drift on a page with a dark theme passes (${dark.filter((one) => one.fails).map((one) => one.line)})`,
  );
  expect(
    dark.filter((one) => /^drift, (control|token) [^:]+: FAIL /u.test(one.line)).length ===
      2 * widths,
    '1. the 2px shift and the token change each fail their capture at every width',
  );
  expect(
    dark.filter((one) => one.line.includes('drawn in dark, not as light')).length === widths,
    '1. every width is proved drawn in dark',
  );
  const flat = await run('/no-dark', '--text', 'dark');
  expect(
    flat.filter((one) => one.fails && one.line.includes('has no dark theme')).length === widths,
    '2. a page with no dark theme is refused in dark at every width',
  );
  const unset = await run('/', '--not-set', 'light');
  expect(
    unset.some((one) => one.fails && one.line.includes('not set on this page')),
    '3. a token the page never sets is refused',
  );

  const file = join(out, 'session.json');
  const value = JSON.stringify({
    token: 'made-up',
    businessKey: 'alpha',
    email: 'a@example.invalid',
  });
  writeFileSync(
    file,
    JSON.stringify({
      cookies: [],
      origins: [{ origin: app.origin, localStorage: [{ name: 'ops-astro.session', value }] }],
    }),
  );
  const browser = await chromium.launch(MODE);
  try {
    const side = await openSide(browser, readPacket(), 390, { app, session: file });
    const tab = await side.context.newPage();
    await tab.goto(app.href);
    const seen = await tab.evaluate(() => ({
      drawn: document.getElementById('held')?.textContent,
      local: localStorage.length,
    }));
    expect(seen.drawn === value, "4. the session is in sessionStorage before the page's script");
    expect(seen.local === 0, '4. and nothing is in localStorage');
    await side.context.close();
  } finally {
    await browser.close();
  }
} finally {
  server.close();
  rmSync(out, { recursive: true, force: true });
}
console.log(
  failures.length === 0 ? 'app-drift cases: pass' : `app-drift cases: ${failures.length} red`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
