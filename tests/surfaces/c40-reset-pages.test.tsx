// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C40, piece P3: the forgot-password screens in the mounted app. Sign-in links
// to "Forgot password"; that page posts the address in the body to
// `/api/password/reset` with no credentials and says one thing whatever the
// address. The reset link (`/reset#token_hash=...`) opens the set-a-password
// page: the token is read from the fragment and taken off the address, given to
// the login provider's own verify, and the new password goes with the recovery
// session's bearer to `/api/password/set`. The routes' own behaviour runs on
// the database in `tests/api/c40-password-set.test.ts` and its P2 tests.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { gateOf } from '../../apps/web/src/route-gate.ts';
import { matchRoute, pathTo } from '../../apps/web/src/routes.ts';
import { SessionStore, tabStorage, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const GOTRUE = 'http://identity.invalid';
const HASH = 'pkce_c40-made-up-recovery-token-hash';
const ACCESS = 'c40-made-up-recovery-access-token';
const PASSWORD = 'correct horse battery';

function storage(): StorageLike {
  const held = new Map<string, string>();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

type Answer = { readonly status: number; readonly body: unknown } | 'throw' | 'hold';

/** What each address answers; an address not named never answers. */
interface Answers {
  readonly reset?: Answer;
  readonly verify?: Answer;
  readonly set?: readonly Answer[];
}

let shown: Mounted | undefined;
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
  vi.restoreAllMocks();
});

const never = (): Promise<Response> =>
  new Promise<Response>(() => {
    /* never answers */
  });

async function reply(answer: Answer | undefined): Promise<Response> {
  if (answer === undefined || answer === 'hold') return await never();
  if (answer === 'throw') throw new TypeError('network down');
  return new Response(JSON.stringify(answer.body), { status: answer.status });
}

/** The app at `path`, signed out; every request and navigation is kept. */
async function open(
  path: string,
  answers: Answers,
): Promise<{ view: Mounted; sent: Sent[]; went: string[] }> {
  await shown?.unmount();
  const sent: Sent[] = [];
  const went: string[] = [];
  const sets = [...(answers.set ?? [])];
  const fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, init });
    if (url.endsWith('/api/password/reset')) return await reply(answers.reset);
    if (url === `${GOTRUE}/verify`) return await reply(answers.verify);
    if (url.endsWith('/api/password/set')) return await reply(sets.shift());
    return await never();
  }) as typeof globalThis.fetch;
  const view = await mount(
    <App
      path={path}
      navigate={(next) => {
        went.push(next);
      }}
      sessions={new SessionStore(storage())}
      gotrueUrl={GOTRUE}
      apiOrigin=""
      fetch={fetch}
      storage={tabStorage()}
    />,
  );
  shown = view;
  return { view, sent, went };
}

const RESET_LINK = `${pathTo('agency:reset')}#token_hash=${HASH}&type=recovery`;
const VERIFIED = { status: 200, body: { access_token: ACCESS, token_type: 'bearer' } };
const SET_OK = { status: 200, body: { signedOutAtProvider: true } };

async function flush(): Promise<void> {
  await settle();
  await settle();
  await settle();
}

async function ask(view: Mounted, address = 'name@example.test'): Promise<void> {
  await view.type('#reset-address', address);
  await view.click('[data-reset="ask"] button[type="submit"]');
  await flush();
}

async function setIt(view: Mounted, password = PASSWORD): Promise<void> {
  await view.type('#reset-password', password);
  await view.click('[data-reset="form"] button[type="submit"]');
  await flush();
}

const to = (sent: Sent[], end: string): Sent[] => sent.filter((one) => one.url.endsWith(end));

// eslint-disable-next-line max-lines-per-function -- the two pages' states, one mounted app each
describe('C40 forgot-password screens', () => {
  it('C40 forgot link: sign-in offers "Forgot password", and its page needs no sign-in', async () => {
    const { view } = await open(pathTo('agency:sign-in'), {});
    const link = view.find(`a[href="${pathTo('agency:forgot-password')}"]`);
    expect(link?.textContent).toBe('Forgot password');
    expect(gateOf(matchRoute('/forgot-password'), false).kind).toBe('open');
    expect(gateOf(matchRoute('/reset'), false).kind).toBe('open');
    const forgot = await open(pathTo('agency:forgot-password'), {});
    expect(forgot.view.find('#reset-address')).not.toBeNull();
    expect(forgot.view.find('#signin-password')).toBeNull();
  });

  it('C40 forgot sending and sent: the address goes in the body with no credentials, then the one answer', async () => {
    const held = await open(pathTo('agency:forgot-password'), { reset: 'hold' });
    await ask(held.view);
    const button = held.view.find('[data-reset="ask"] button[type="submit"]');
    expect(button?.getAttribute('aria-busy')).toBe('true');
    expect(button?.textContent).toBe('Sending…');

    const { view, sent, went } = await open(pathTo('agency:forgot-password'), {
      reset: { status: 200, body: {} },
    });
    await ask(view);
    const [request] = to(sent, '/api/password/reset');
    expect(request?.url).toBe('/api/password/reset');
    expect(request?.init?.method).toBe('POST');
    expect(request?.init?.credentials).toBe('omit');
    expect(JSON.parse(String(request?.init?.body))).toStrictEqual({ address: 'name@example.test' });
    expect(view.find('[data-reset="sent"]')?.textContent).toContain(
      'If that address has an account, a link to set a new password is on its way.',
    );
    await view.click('[data-reset="sent"] button');
    expect(went).toStrictEqual([pathTo('agency:sign-in')]);
  });

  it('C40 no account oracle (page): a known and an unknown address are told the same', async () => {
    const said: string[] = [];
    for (const address of ['known@example.test', 'nobody@example.test']) {
      // oxlint-disable-next-line no-await-in-loop
      const { view } = await open(pathTo('agency:forgot-password'), {
        reset: { status: 200, body: {} },
      });
      // oxlint-disable-next-line no-await-in-loop
      await ask(view, address);
      said.push(view.find('[data-reset="sent"]')?.textContent ?? 'not sent');
    }
    expect(said[0]).toBe(said[1]);
    expect(said[0]).not.toContain('known@example.test');
  });

  it('C40 forgot unavailable: a request that never reached the API keeps the form and says try again', async () => {
    const { view } = await open(pathTo('agency:forgot-password'), { reset: 'throw' });
    await ask(view);
    expect(view.find('[data-reset="sent"]')).toBeNull();
    expect(view.find('#reset-address')).not.toBeNull();
    expect(view.text()).toContain('try again in a minute');
  });

  it('C40 set password: the token leaves the address, is verified with the provider, then the password goes with the recovery bearer; done leads to sign-in', async () => {
    const { view, sent, went } = await open(RESET_LINK, { verify: VERIFIED, set: [SET_OK] });
    expect(went).toStrictEqual([pathTo('agency:reset')]);
    expect(sent).toHaveLength(0);
    await setIt(view);
    const [verify] = to(sent, '/verify');
    expect(verify?.url).toBe(`${GOTRUE}/verify`);
    expect(verify?.init?.method).toBe('POST');
    expect(JSON.parse(String(verify?.init?.body))).toStrictEqual({
      type: 'recovery',
      token_hash: HASH,
    });
    const [set] = to(sent, '/api/password/set');
    expect(set?.url).toBe('/api/password/set');
    expect(set?.init?.credentials).toBe('omit');
    expect(new Headers(set?.init?.headers).get('authorization')).toBe(`Bearer ${ACCESS}`);
    expect(JSON.parse(String(set?.init?.body))).toStrictEqual({ password: PASSWORD });
    expect(view.find('[data-reset="done"]')?.textContent).toContain('Your new password is set');
    expect(view.find('#reset-password')).toBeNull();
    await view.click('[data-reset="done"] button');
    expect(went.at(-1)).toBe(pathTo('agency:sign-in'));
  });

  it('C40 set link expired or invalid: a refused or missing token says so, sends no password, and offers a new link', async () => {
    const expired = await open(RESET_LINK, {
      verify: {
        status: 403,
        body: { code: 'otp_expired', msg: 'Email link is invalid or has expired' },
      },
    });
    await setIt(expired.view);
    expect(expired.view.find('[data-reset="invalid"]')).not.toBeNull();
    expect(to(expired.sent, '/api/password/set')).toHaveLength(0);
    await expired.view.click('[data-reset="invalid"] button');
    expect(expired.went.at(-1)).toBe(pathTo('agency:forgot-password'));

    const bare = await open(pathTo('agency:reset'), {});
    expect(bare.view.find('[data-reset="invalid"]')).not.toBeNull();
    expect(bare.sent).toHaveLength(0);

    const spent = await open(RESET_LINK, {
      verify: VERIFIED,
      set: [{ status: 401, body: { code: 'RESET_LINK_INVALID' } }],
    });
    await setIt(spent.view);
    expect(spent.view.find('[data-reset="invalid"]')).not.toBeNull();
  });

  it('C40 set password rules: outside 12 to 72 bytes is refused at the field with nothing sent; the API refusing it keeps the verified link', async () => {
    const short = await open(RESET_LINK, { verify: VERIFIED, set: [SET_OK] });
    await setIt(short.view, 'short');
    expect(short.sent).toHaveLength(0);
    expect(short.view.find('#reset-password')?.getAttribute('aria-invalid')).toBe('true');
    expect(short.view.find('#reset-password-error')?.textContent).toBe('Use 12 to 72 characters.');

    const refused = await open(RESET_LINK, {
      verify: VERIFIED,
      set: [{ status: 400, body: { code: 'PASSWORD_INVALID' } }, SET_OK],
    });
    await setIt(refused.view);
    expect(refused.view.find('#reset-password-error')?.textContent).toBe(
      'Use 12 to 72 characters.',
    );
    await setIt(refused.view, `${PASSWORD} again`);
    expect(to(refused.sent, '/verify')).toHaveLength(1);
    expect(to(refused.sent, '/api/password/set')).toHaveLength(2);
    expect(refused.view.find('[data-reset="done"]')).not.toBeNull();
  });

  it('C40 set unavailable: the provider or the API being down keeps the form and says nothing changed', async () => {
    for (const answers of [
      { verify: { status: 503, body: {} } },
      { verify: 'throw' as const },
      { verify: VERIFIED, set: [{ status: 503, body: { code: 'RESET_UNAVAILABLE' } }] },
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const { view } = await open(RESET_LINK, answers);
      // oxlint-disable-next-line no-await-in-loop
      await setIt(view);
      expect(view.find('#reset-password'), JSON.stringify(answers)).not.toBeNull();
      expect(view.text()).toContain('Nothing changed');
    }
  });

  it('C40 token canary (page): the token and the bearer never reach an address, the console or the page', async () => {
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const { view, sent } = await open(RESET_LINK, {
      verify: VERIFIED,
      set: [{ status: 503, body: {} }, SET_OK],
    });
    await setIt(view);
    await setIt(view);
    expect(view.find('[data-reset="done"]')).not.toBeNull();
    for (const request of sent) {
      expect(request.url).not.toContain(HASH);
      expect(request.url).not.toContain(ACCESS);
    }
    expect(view.text()).not.toContain(HASH);
    expect(document.body.innerHTML).not.toContain(ACCESS);
    for (const spy of logged) expect(JSON.stringify(spy.mock.calls)).not.toMatch(/c40-made-up/u);
  });
});
