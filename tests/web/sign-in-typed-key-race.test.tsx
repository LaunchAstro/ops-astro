// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// Race attack on the typed business key (fix/sign-in-any-business). The page
// now takes any key a person types, and `openSignIn` ends the half-made cookie
// and fails as a wrong password only when the read is refused
// `AUTH_NO_MEMBERSHIP`. These attack that one write.
//
// 1. A key the router never reaches with `/api/b/<key>/` (`.`, `..`) or one the
//    database cannot look up (a NUL) is answered 404 or 503, not
//    `AUTH_NO_MEMBERSHIP`. It must still fail, open nothing and keep no cookie;
//    its words are the API's own, which name no business. Through the server's
//    own composition, over a throwaway database.
// 2. A sign-out still in flight as the sign-in starts schedules the session to
//    be written again once it lands (`openSession`). When it lands during the
//    read, that write races the failure's own end and can put the cookie back.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { act } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignIn } from '../../apps/web/src/screens/SignIn.tsx';
import { signOut } from '../../apps/web/src/session/sign-in.ts';
import type { Session } from '../../apps/web/src/session/token.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createApiFixture, tokenFor, type ApiFixture } from '../api/fixture.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { mount, settle } from '../surfaces/mount.tsx';
import { json } from './mp-2-1-support.tsx';
import { held, refusal } from './sign-in-again-support.tsx';

const serverUrl = databaseUrlFromEnvironment();
const PASSWORD = 'the-right-password';
const WRONG_PASSWORD = { error: 'invalid_grant', error_description: 'Invalid login credentials' };

let fixture: ApiFixture;
let api: Hono;
let subject: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  fixture = await createApiFixture('signinrace');
  api = fixture.compose();
  const business = await insertBusiness(fixture.db.app, 'agency-astro');
  subject = `owner-${randomUUID()}`;
  await fixture.db.app.withBusiness(business as never, async (tx) => {
    const person = await insertPerson(tx, 'Owner');
    const actor = await insertActor(tx, person);
    await insertMapping(tx, await insertLogin(tx, subject), person, actor);
    await insertMembership(tx, person);
  });
}, 120_000);

afterAll(async () => {
  await fixture?.drop();
});

/** GoTrue on a stand-in address, the real API behind it, and the cookies a browser keeps. */
function browser() {
  const cookies = new Map<string, string>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('http://identity.invalid/token')) {
      const sent = JSON.parse(String(init?.body)) as { password: string };
      return sent.password === PASSWORD
        ? Response.json({ access_token: await tokenFor(subject) })
        : Response.json(WRONG_PASSWORD, { status: 400 });
    }
    const headers = new Headers(init?.headers);
    headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    // As a browser does, the address is normalised before it is sent.
    const response = await api.fetch(new Request(`http://api.test${url}`, { ...init, headers }));
    for (const cookie of response.headers.getSetCookie()) {
      const [key = '', ...value] = (cookie.split(';')[0] ?? '').split('=');
      if (value.join('=') === '') cookies.delete(key);
      else cookies.set(key, value.join('='));
    }
    return response;
  };
  return { fetch, cookies };
}

async function signInTo(business: string, password = PASSWORD) {
  const { fetch, cookies } = browser();
  const opened: Session[] = [];
  const page = await mount(
    <SignIn
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      ended={null}
      build={null}
      onSignedIn={(session) => opened.push(session)}
    />,
  );
  await page.type('#signin-email', 'owner@example.test');
  await page.type('#signin-password', password);
  await page.choose('#signin-business', business);
  await page.click('button[type="submit"]');
  await vi.waitFor(() => expect(page.find('button[type="submit"]')?.textContent).toBe('Sign in'));
  await settle();
  const said = page.find('#signin-password-error')?.textContent ?? null;
  await page.unmount();
  return {
    opened: opened.map((session) => session.businessKey),
    said,
    cookies: [...cookies.keys()],
  };
}

describe.skipIf(serverUrl === undefined)('a typed key no business can hold', () => {
  it.each([
    ['dot', '.'],
    ['dot dot', '..'],
    ['NUL', 'x\u0000y'],
  ])('fails and keeps no cookie: %s', async (_name, key) => {
    const wrongPassword = await signInTo('agency-astro', 'not-the-password');
    const wrongKey = await signInTo(key);
    expect(wrongKey.opened, 'A key no business holds must not open a sign-in.').toEqual([]);
    expect(wrongKey.said).toMatch(/^The API answered \d{3}\.$/u);
    expect(wrongKey.cookies).toEqual(wrongPassword.cookies);
  });
});

// eslint-disable-next-line max-lines-per-function -- one held sign-out, sign-in and rewrite, read as one case
it('a sign-out landing during the read cannot put the refused cookie back', async () => {
  const oldEnd = held();
  const rewrite = held();
  const probe = held();
  const jar = new Set<string>();
  let trades = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const named = new Headers(init?.headers).get('x-ops-astro-session');
    if (url.startsWith('http://identity.invalid/token')) return json({ access_token: 'aal1' });
    if (url === '/api/session/end' && named === 'old') return await oldEnd.wait();
    if (url === '/api/session/end' && named === 'half') {
      jar.delete('half');
      return json({ ok: true });
    }
    if (url === '/api/session') {
      trades += 1;
      // The trade sets the cookie as its answer arrives; the second is the
      // rewrite `openSession` sends once the earlier sign-out has landed.
      const answer = trades === 1 ? json({ ok: true, session: 'half' }) : await rewrite.wait();
      jar.add('half');
      return answer;
    }
    if (url.endsWith('/session/person')) return await probe.wait();
    return json({ ok: true });
  };

  // The tab's last sign-out is still on its way as the page offers sign-in again.
  const leaving = signOut({ apiOrigin: '', fetch: fetcher, sessionId: 'old' });
  const opened: Session[] = [];
  const view = await mount(
    <SignIn
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetcher}
      ended={null}
      build={null}
      signedOut
      onSignedIn={(session) => opened.push(session)}
    />,
  );
  await view.type('#signin-email', 'mia@example.test');
  await view.type('#signin-password', 'test-password');
  await view.choose('#signin-business', 'not-mine');
  await view.click('[data-screen="sign-in"] button[type="submit"]');
  await settle();
  expect(jar.has('half')).toBe(true);

  await act(async () => {
    oldEnd.answer(json({ ok: true }));
    await leaving;
    await settle();
  });
  expect(trades, 'The earlier sign-out landed, so the session is written again.').toBe(2);

  // The refusal comes first, and the rewrite already sent is answered after it.
  await act(async () => {
    probe.answer(refusal('AUTH_NO_MEMBERSHIP', [], 403));
    await settle();
  });
  await act(async () => {
    rewrite.answer(json({ ok: true, session: 'half' }));
    await settle();
  });
  await vi.waitFor(() =>
    expect(view.find('#signin-password-error')?.textContent).toBe('Invalid login credentials'),
  );

  expect(opened).toEqual([]);
  expect(
    [...jar],
    'A sign-in that failed as a wrong password leaves no cookie for the API to act on.',
  ).toEqual([]);
});
