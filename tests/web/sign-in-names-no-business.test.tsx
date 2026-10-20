// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// OA-ReadyWalk STEP 1: the sign-in page offered only the alpha and bravo seed
// businesses, so a real business could not be chosen. The page now asks for
// the business by its key and lists none: a public page never names another
// tenant. A key the person cannot sign in to, held by another business or by
// none, fails as a wrong password does, and its half-made session is ended.
//
// Through the server's own composition, over a throwaway database.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignIn } from '../../apps/web/src/screens/SignIn.tsx';
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

const serverUrl = databaseUrlFromEnvironment();
const PASSWORD = 'the-right-password';
/** GoTrue's own answer to a wrong password. */
const WRONG_PASSWORD = { error: 'invalid_grant', error_description: 'Invalid login credentials' };

let fixture: ApiFixture;
let api: Hono;
let subject: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  fixture = await createApiFixture('signinkey');
  api = fixture.compose();
  // Agency Astro, with its owner its one member; the fixture's alpha they are not in.
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

async function signIn(business: string, password = PASSWORD) {
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
  return { opened, said, cookies };
}

describe.skipIf(serverUrl === undefined)('signing in to a business by its key', () => {
  it('opens a business that is not alpha or bravo', async () => {
    const { opened, said } = await signIn('agency-astro');
    expect(said).toBeNull();
    expect(opened.map((session) => session.businessKey)).toEqual(['agency-astro']);
  });

  it('fails a key held by another business, or by none, as a wrong password fails', async () => {
    const wrongPassword = await signIn('agency-astro', 'not-the-password');
    expect(wrongPassword.said).toBe('Invalid login credentials');
    for (const key of ['alpha', 'no-business-holds-this']) {
      // eslint-disable-next-line no-await-in-loop -- one browser at a time, as a person signs in
      const wrongKey = await signIn(key);
      expect(wrongKey.said, key).toBe(wrongPassword.said);
      expect(wrongKey.opened, key).toEqual([]);
      // The half-made session goes: no cookie is left that the API would act on.
      expect([...wrongKey.cookies.keys()], key).toEqual([...wrongPassword.cookies.keys()]);
    }
  });
});

describe('the sign-in page', () => {
  it('names no business', async () => {
    const page = await mount(
      <SignIn
        gotrueUrl="http://identity.invalid"
        apiOrigin=""
        fetch={globalThis.fetch}
        ended={null}
        build={null}
        onSignedIn={() => {}}
      />,
    );
    expect(page.all('option, datalist')).toEqual([]);
    expect((page.find('#signin-business') as HTMLInputElement | null)?.value).toBe('');
    expect(page.host.innerHTML).not.toMatch(/alpha|bravo/iu);
    await page.unmount();
  });
});
