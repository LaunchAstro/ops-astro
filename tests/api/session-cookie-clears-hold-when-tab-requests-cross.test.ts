// SPDX-License-Identifier: AGPL-3.0-only
//
// The door clears other sign-ins' cookies from what one request carries
// (`staleSessions`): each read decides from the Cookie header it was sent
// with, and the browser applies the answer's clears to its jar whenever the
// answer lands. Two tabs' reads cross on the wire, a tab signs in while
// another's read is out, and an answer is lost and its read sent again. In
// each, the jar ends where one read at a time would leave it: the five newest
// other sign-ins beside a tab's own, no planted cookie, and no cookie of a
// sign-in the answer never saw.

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { cookieNameFor } from '../../apps/api/auth/session.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import {
  SESSION_COOKIE,
  SESSION_HEADER,
  SESSION_PATH,
} from '../../packages/core-wire/src/index.ts';
import { signBearer, testSignIn } from '../support/sign-in.ts';
import { BOARD, ISSUER, SAME_ORIGIN, database, post } from './session-cookie.fixture.ts';

function build() {
  return createApi({
    database,
    verify: createSupabaseVerifier(testSignIn(ISSUER)),
    resolveBusiness: (key) => Promise.resolve(key === 'alpha' ? 'business-alpha' : undefined),
    executeRead: (() => Promise.resolve({ ok: true, tasks: [] })) as never,
    executeCommand: (() => Promise.resolve({ recordId: 'r-1', revision: 1 })) as never,
  });
}

/** The browser's jar for the API's origin, honouring `Max-Age`. */
function jar() {
  const held = new Map<string, { value: string; until: number }>();
  const live = () => [...held].filter(([, cookie]) => cookie.until > Date.now());
  return {
    take(lines: readonly string[]): void {
      for (const line of lines) {
        const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
        const [name = '', ...value] = pair.split('=');
        const maxAge = attributes.find((a) => /^max-age=/iu.test(a));
        const seconds = maxAge === undefined ? Infinity : Number(maxAge.slice(8));
        if (seconds <= 0) held.delete(name);
        else held.set(name, { value: value.join('='), until: Date.now() + seconds * 1000 });
      }
    },
    plant(name: string, value: string): void {
      held.set(name, { value, until: Infinity });
    },
    header: (): string =>
      live()
        .map(([name, { value }]) => `${name}=${value}`)
        .join('; '),
    sessions: (): string[] =>
      live()
        .map(([name]) => name)
        .filter((name) => name.startsWith(SESSION_COOKIE))
        .toSorted(),
  };
}

type Jar = ReturnType<typeof jar>;

/** A new tab signs in with the claims GoTrue puts on a password sign-in; a minute passes. */
async function newTab(api: ReturnType<typeof build>, cookies: Jar, n: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const sub = '0b6c1f4e-8f0e-4d8a-9b3e-2f6a7c1d5e90';
  const token = await signBearer({
    sub,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    email: 'mia@alpha.local',
    aal: 'aal1',
    amr: [{ method: 'password', timestamp: now }],
    session_id: `0b6c1f4e-8f0e-4d8a-9b3e-${String(n).padStart(12, '0')}`,
    iat: now,
    exp: now + 3600,
  });
  const answer = await post(api, SESSION_PATH, {
    ...SAME_ORIGIN,
    authorization: `Bearer ${token}`,
  });
  expect(answer.status).toBe(200);
  cookies.take(answer.headers.getSetCookie());
  vi.setSystemTime(Date.now() + 60_000);
  return ((await answer.json()) as { session: string }).session;
}

async function tabs(api: ReturnType<typeof build>, cookies: Jar, count: number) {
  const signed: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    // eslint-disable-next-line no-await-in-loop -- one tab after another, each a minute later
    signed.push(await newTab(api, cookies, n));
  }
  return signed;
}

/** The API on a real socket, so reads sent at once arrive on separate connections. */
async function listening(api: ReturnType<typeof build>) {
  const server = serve({ fetch: api.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  /** One tab's read, sent with the Cookie header given; answers its status and `Set-Cookie`s. */
  const read = async (session: string, cookie: string) => {
    const answer = await fetch(`${base}${BOARD}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...SAME_ORIGIN,
        cookie,
        [SESSION_HEADER]: session,
      },
      body: '{}',
    });
    await answer.arrayBuffer();
    return { status: answer.status, lines: answer.headers.getSetCookie() };
  };
  return { read, close: () => server.close() };
}

const names = (sessions: readonly string[]) => sessions.map((id) => cookieNameFor(id)).toSorted();

/** A token whose `exp` claims ten years: no sign-in this API issued. */
const planted = (n: number) => ({
  name: cookieNameFor(n.toString(16).padStart(32, 'f')),
  value: [
    'e30',
    Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 10 * 365 * 86_400 }),
    ).toString('base64url'),
    'sig',
  ].join('.'),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session cookie clears hold when tab requests cross', () => {
  it('two tabs reading at once with one cookie too many leave six, as one read at a time does', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const api = build();
    const cookies = jar();
    const signed = await tabs(api, cookies, 7);
    const server = await listening(api);
    try {
      // Tabs 1 and 2, the two oldest sign-ins, read at once with the same seven cookies.
      const sent = cookies.header();
      const [first, second] = await Promise.all([
        server.read(signed[0] ?? '', sent),
        server.read(signed[1] ?? '', sent),
      ]);
      expect([first?.status, second?.status]).toEqual([200, 200]);
      cookies.take([...(first?.lines ?? []), ...(second?.lines ?? [])]);
    } finally {
      server.close();
    }
    // One at a time, whichever goes first clears one cookie and the other,
    // its own gone or not, clears nothing: six stay, the cap.
    expect(cookies.sessions(), 'the jar keeps the cap, not one fewer').toHaveLength(6);
  });

  it('two tabs reading at once beside planted cookies clear every planted one and no live tab', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const api = build();
    const cookies = jar();
    const signed = await tabs(api, cookies, 6);
    for (const n of [1, 2, 3, 4, 5]) {
      const cookie = planted(n);
      cookies.plant(cookie.name, cookie.value);
    }
    const server = await listening(api);
    try {
      const sent = cookies.header();
      const answers = await Promise.all([
        server.read(signed[0] ?? '', sent),
        server.read(signed[5] ?? '', sent),
      ]);
      expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
      cookies.take(answers.flatMap((answer) => answer.lines));
    } finally {
      server.close();
    }
    expect(cookies.sessions()).toEqual(names(signed));
  });

  it('a tab signing in while another tab’s read is out keeps its new cookie', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const api = build();
    const cookies = jar();
    const signed = await tabs(api, cookies, 7);
    const server = await listening(api);
    try {
      // Tab 7's read leaves with seven cookies; tab 8 signs in before its answer lands.
      const out = server.read(signed[6] ?? '', cookies.header());
      const eighth = await newTab(api, cookies, 8);
      const answer = await out;
      expect(answer.status).toBe(200);
      cookies.take(answer.lines);
      expect(cookies.sessions()).toContain(cookieNameFor(eighth));
      const own = await server.read(eighth, cookies.header());
      expect(own.status, 'tab 8 reads on its own cookie').toBe(200);
      cookies.take(own.lines);
      expect(cookies.sessions()).toContain(cookieNameFor(eighth));
    } finally {
      server.close();
    }
  });

  it('a read whose answer is lost and is sent again clears what one answer clears, and the late answer nothing more', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const api = build();
    const cookies = jar();
    const signed = await tabs(api, cookies, 7);
    const server = await listening(api);
    try {
      const lost = await server.read(signed[6] ?? '', cookies.header());
      // The answer never reaches the jar; the tab sends the read again.
      const again = await server.read(signed[6] ?? '', cookies.header());
      expect([lost.status, again.status]).toEqual([200, 200]);
      cookies.take(again.lines);
      expect(cookies.sessions()).toEqual(names(signed.slice(1)));
      // The lost answer arrives after all.
      cookies.take(lost.lines);
      expect(cookies.sessions()).toEqual(names(signed.slice(1)));
    } finally {
      server.close();
    }
  });
});
