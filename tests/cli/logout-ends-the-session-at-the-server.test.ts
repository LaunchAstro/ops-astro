// SPDX-License-Identifier: AGPL-3.0-only
//
// `logout` ends the session at the server, not only on this machine (#2425).
// Removing the bearer file alone leaves the session open: a copy of the token
// elsewhere keeps working until it expires. With a business named, logout
// posts the person's own `account/sessions/sign-out` (C58) with the stored
// bearer, the route the web's sign-out and a left code step already use. The
// files go first, so a server that is slow or never answers cannot leave the
// token on disk, and the request has a time limit, so logout always returns.
// It says whether the server ended the session, and never prints the bearer.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { signOutAtServer } from '../../apps/cli/sign-out-at-server.ts';
import { run, standIn, type Route, type Seen } from './preset-stand-in.ts';

const API = 'https://api.example.test';
const BEARER = 'logout-bearer-canary-5d1e';
const SIGN_OUT = `${API}/api/b/alpha/account/sessions/sign-out`;

let folder: string;
let token: string;
let delegation: string;
let seen: Seen[];

const env = (extra: Readonly<Record<string, string>> = {}) => ({
  OPS_ASTRO_API_URL: API,
  OPS_ASTRO_TOKEN_FILE: token,
  OPS_ASTRO_DELEGATION_FILE: delegation,
  ...extra,
});

const answering = (route?: Route) => {
  const stand = standIn(route);
  seen = stand.seen;
  vi.stubGlobal('fetch', stand.fetch);
};

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-logout-ends-'));
  token = join(folder, 'token');
  delegation = join(folder, 'pickup');
  writeFileSync(token, `${BEARER}\n`, { mode: 0o600 });
  writeFileSync(delegation, 'pickup-canary\n', { mode: 0o600 });
  answering();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(folder, { recursive: true, force: true });
});

const gone = () => [existsSync(token), existsSync(delegation)];

it('with a business named, logout removes the files, then signs the read bearer out at the server', async () => {
  const onDisk: boolean[][] = [];
  answering((url) => {
    if (url.href !== SIGN_OUT) return;
    onDisk.push(gone());
    return Response.json({ ended: 1, provider: 'confirmed' });
  });
  const out = await run(['logout'], env({ OPS_ASTRO_BUSINESS: 'alpha' }));
  expect(out.code, out.err).toBe(0);
  expect(
    seen.map((one) => [one.url, one.headers['authorization'] === `Bearer ${BEARER}`, one.body]),
  ).toStrictEqual([[SIGN_OUT, true, '{}']]);
  expect(seen[0]?.redirect).toBe('manual');
  expect(onDisk).toStrictEqual([[false, false]]);
  expect(gone()).toStrictEqual([false, false]);
  expect(JSON.parse(out.out)).toStrictEqual({ ok: true, ended: true });
  expect(`${out.out}${out.err}`).not.toContain(BEARER);
});

it.each([
  ['refuses', () => Response.json({ refused: true, code: 'AUTH_UNKNOWN_LOGIN' }, { status: 401 })],
  [
    'redirects',
    () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.test/' } }),
  ],
  ['cannot be reached', () => Promise.reject(new TypeError('fetch failed'))],
])(
  'when the server %s, the files still go and logout says the session may be open',
  async (_name, reply) => {
    answering((url) => (url.href === SIGN_OUT ? reply() : undefined));
    const out = await run(['logout'], env({ OPS_ASTRO_BUSINESS: 'alpha' }));
    expect(out.code, out.err).toBe(0);
    expect(gone()).toStrictEqual([false, false]);
    expect(JSON.parse(out.out)).toStrictEqual({ ok: true, ended: false });
    expect(out.err).toContain('the server did not confirm');
    expect(seen.every((one) => new URL(one.url).origin === API)).toBe(true);
    expect(`${out.out}${out.err}`).not.toContain(BEARER);
  },
);

it('with no business named, logout sends nothing, removes the files and says the session stays open', async () => {
  const out = await run(['logout'], env());
  expect(out.code, out.err).toBe(0);
  expect(seen).toStrictEqual([]);
  expect(gone()).toStrictEqual([false, false]);
  expect(JSON.parse(out.out)).toStrictEqual({ ok: true, ended: false });
  expect(out.err).toContain('--business');
});

it('with no saved bearer, logout sends nothing and has nothing to end', async () => {
  rmSync(token);
  const out = await run(['logout'], env({ OPS_ASTRO_BUSINESS: 'alpha' }));
  expect(out.code, out.err).toBe(0);
  expect(seen).toStrictEqual([]);
  expect(JSON.parse(out.out)).toStrictEqual({ ok: true, ended: false });
  expect(out.err).toBe('');
});

it('a server that never answers is given up on at the limit, and says so', async () => {
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason);
      });
    });
    return new Response(null);
  });
  const started = Date.now();
  const answer = await signOutAtServer(API, 'alpha', BEARER, 50);
  expect(answer).toStrictEqual({
    ended: false,
    because: 'the account route did not answer in time',
  });
  expect(Date.now() - started).toBeLessThan(5_000);
});
