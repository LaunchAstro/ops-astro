// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The signed-out reset page, `/reset`. Arriving on a mailed link, it takes the
// provider's one-time hash from the fragment once, and clears it from the
// address bar and the tab's history entry before its first request. It sets
// the password on the provider's recovery session and signs nobody in:
// nothing is kept in the tab's storage, and the person is sent to sign in.
// Arriving with no link, it asks for an address to mail one to.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { ResetScreen } from '../../apps/web/src/screens/Reset.tsx';
import { SignIn } from '../../apps/web/src/screens/SignIn.tsx';
import { drawOpenScreen } from '../../apps/web/src/screen-registry.tsx';
import { matchRoute, type OpenRouteId, type RouteMatch } from '../../apps/web/src/routes.ts';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle } from '../surfaces/mount.tsx';

const PROVIDER = 'http://provider.test';
const SUBJECT = '0b9f6c1e-6a1d-4c39-9b1e-1f0c3a2d4e5f';
const HASH = 'pkce_0123456789abcdef0123456789abcdef0123456789abcdef';
const EMAIL = 'person@example.test';
const ACCESS = `e30.${Buffer.from(JSON.stringify({ sub: SUBJECT })).toString('base64url')}.sig`;

interface Asked {
  readonly url: string;
  readonly method: string;
  /** What the address bar held when the request was sent. */
  readonly hashThen: string;
  readonly body: string;
}

/** How the fake answers `changed`, when not with its 200. */
interface Answers {
  readonly changed?: { readonly status: number; readonly code: string };
}

/** A fetch that answers as the provider and the API would, noting each call. */
function fakeNetwork(asked: Asked[], answers: Answers = {}): typeof globalThis.fetch {
  return async (input, init) => {
    await Promise.resolve();
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    asked.push({
      url,
      method,
      hashThen: window.location.hash,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    const absolute = new URL(url, window.location.origin).toString();
    const reply = (status: number, body?: unknown): Response => {
      const response = new Response(body === undefined ? null : JSON.stringify(body), { status });
      Object.defineProperty(response, 'url', { value: absolute });
      return response;
    };
    if (url === `${PROVIDER}/verify`) {
      return reply(200, { access_token: ACCESS, user: { id: SUBJECT, email: EMAIL } });
    }
    if (url.endsWith('/api/password/changed') && answers.changed !== undefined) {
      return reply(answers.changed.status, { code: answers.changed.code });
    }
    if (url.endsWith('/api/password/reset')) return reply(202, {});
    return reply(200, {});
  };
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
  window.localStorage.clear();
});

it('clears the link from the address before its first request, and signs nobody in', async () => {
  window.history.replaceState({ kept: true }, '', `/reset#token_hash=${HASH}`);
  const asked: Asked[] = [];
  const page = await mount(
    <ResetScreen
      path={`/reset#token_hash=${HASH}`}
      gotrueUrl={PROVIDER}
      apiOrigin=""
      fetch={fakeNetwork(asked)}
      tab={window}
      sessions={new SessionStore(window.sessionStorage)}
    />,
  );
  // Cleared before anything was asked, the history entry's own state kept.
  expect(window.location.hash).toBe('');
  expect(window.location.pathname).toBe('/reset');
  expect(window.history.state).toStrictEqual({ kept: true });
  expect(asked).toStrictEqual([]);
  expect(page.text()).not.toContain(HASH);

  await page.type('#reset-password', 'a-new-password-for-reset');
  await page.type('#reset-confirm', 'a-new-password-for-reset');
  await page.click('button[type="submit"]');
  for (let i = 0; i < 10; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each call answers after the one before
    await settle();
  }

  expect(asked.map((one) => `${one.method} ${one.url}`)).toStrictEqual([
    `POST ${PROVIDER}/verify`,
    'POST /api/password/begin',
    'POST /api/password/changed',
  ]);
  expect(asked.every((one) => one.hashThen === '')).toBe(true);
  expect(asked[0]?.body).toContain(HASH);
  // The password went once, to the API's changed, which writes it on the session.
  expect(
    asked
      .filter((one) => one.body.includes('a-new-password-for-reset'))
      .map((one) => `${one.method} ${one.url}`),
  ).toStrictEqual(['POST /api/password/changed']);
  expect(page.find('[data-outcome="changed"]')).not.toBeNull();
  expect(page.find('a[href="/sign-in"]')).not.toBeNull();
  // Nobody is signed in: nothing kept in the tab, no cookie set.
  expect(window.sessionStorage).toHaveLength(0);
  expect(window.localStorage).toHaveLength(0);
  expect(document.cookie).toBe('');
});

it('asks for an address when it arrives with no link, and answers every address alike', async () => {
  window.history.replaceState(null, '', '/reset');
  const asked: Asked[] = [];
  const page = await mount(
    <ResetScreen
      path="/reset"
      gotrueUrl={PROVIDER}
      apiOrigin=""
      fetch={fakeNetwork(asked)}
      tab={window}
      sessions={new SessionStore(window.sessionStorage)}
    />,
  );
  expect(page.find('#reset-password')).toBeNull();
  await page.type('#reset-email', 'someone@example.test');
  await act(() => {
    (page.find('form') as HTMLFormElement).requestSubmit();
  });
  await settle();
  expect(asked.map((one) => `${one.method} ${one.url}`)).toStrictEqual([
    'POST /api/password/reset',
  ]);
  expect(JSON.parse(asked[0]?.body ?? '{}')).toStrictEqual({ email: 'someone@example.test' });
  expect(page.find('[data-outcome="asked"]')).not.toBeNull();
});

/** Choose the password twice, submit, and let every call answer. */
async function changeTo(page: Awaited<ReturnType<typeof mount>>, password: string) {
  await page.type('#reset-password', password);
  await page.type('#reset-confirm', password);
  await page.click('button[type="submit"]');
  for (let i = 0; i < 10; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each call answers after the one before
    await settle();
  }
}

/** The reset page as the application draws it, at `path`. */
function resetAt(path: string, fetch: typeof globalThis.fetch, sessions: SessionStore) {
  const match = matchRoute('/reset') as RouteMatch<OpenRouteId>;
  return drawOpenScreen(match, { path, gotrueUrl: PROVIDER, apiOrigin: '', fetch, sessions });
}

it('takes a second link arriving in the same tab as its own, not the first', async () => {
  const second = 'pkce_fedcba9876543210fedcba9876543210fedcba9876543210';
  const asked: Asked[] = [];
  const sessions = new SessionStore(window.sessionStorage);
  window.history.replaceState(null, '', `/reset#token_hash=${HASH}`);
  const page = await mount(resetAt(`/reset#token_hash=${HASH}`, fakeNetwork(asked), sessions));
  window.history.replaceState(null, '', `/reset#token_hash=${second}`);
  await page.render(resetAt(`/reset#token_hash=${second}`, fakeNetwork(asked), sessions));

  expect(window.location.hash).toBe('');
  await changeTo(page, 'a-new-password-for-reset');
  const verified = asked.filter((one) => one.url === `${PROVIDER}/verify`);
  expect(verified.map((one) => JSON.parse(one.body).token_hash)).toStrictEqual([second]);
});

it("ends the tab's session of the login it reset, so sign-in asks again", async () => {
  const sessions = new SessionStore(window.sessionStorage);
  sessions.set({ businessKey: 'alpha', email: 'Person@Example.test', sessionId: 'tab-session' });
  window.history.replaceState(null, '', `/reset#token_hash=${HASH}`);
  const page = await mount(resetAt(`/reset#token_hash=${HASH}`, fakeNetwork([]), sessions));
  await changeTo(page, 'a-new-password-for-reset');

  expect(page.find('[data-outcome="changed"]')).not.toBeNull();
  // The next document, the sign-in link's, reads the tab afresh.
  expect(new SessionStore(window.sessionStorage).session).toBeNull();
});

it("leaves another person's session in the tab alone", async () => {
  const sessions = new SessionStore(window.sessionStorage);
  const theirs = { businessKey: 'bravo', email: 'someone-else@example.test', sessionId: 'theirs' };
  sessions.set(theirs);
  window.history.replaceState(null, '', `/reset#token_hash=${HASH}`);
  const page = await mount(resetAt(`/reset#token_hash=${HASH}`, fakeNetwork([]), sessions));
  await changeTo(page, 'a-new-password-for-reset');

  expect(page.find('[data-outcome="changed"]')).not.toBeNull();
  expect(new SessionStore(window.sessionStorage).session).toStrictEqual(theirs);
});

it('says an unconfirmed change is unconfirmed, never that the password is unchanged', async () => {
  window.history.replaceState(null, '', `/reset#token_hash=${HASH}`);
  const network = fakeNetwork([], { changed: { status: 409, code: 'RESET_NOT_CONFIRMED' } });
  const page = await mount(
    resetAt(`/reset#token_hash=${HASH}`, network, new SessionStore(window.sessionStorage)),
  );
  await changeTo(page, 'a-new-password-for-reset');

  const alert = page.find('[role="alert"]')?.textContent ?? '';
  expect(alert).toContain('could not confirm');
  expect(alert).not.toContain('not changed');
  expect(page.find('#reset-password')).not.toBeNull();
});

it('offers sign-in a way to reset a forgotten password', async () => {
  const page = await mount(
    <SignIn
      gotrueUrl={PROVIDER}
      apiOrigin=""
      fetch={fakeNetwork([])}
      onSignedIn={() => {}}
      ended={null}
    />,
  );
  const link = page.find('a[href="/reset"]');
  expect(link?.textContent).toBe('Forgot password');
});
