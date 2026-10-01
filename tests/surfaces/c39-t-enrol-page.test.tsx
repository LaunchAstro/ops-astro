// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: the enrolment page in the mounted app. `/enrol/:token`
// draws the set-a-password form signed in or out, posts the link's token and
// the password in the body to `/api/enrol` with no credentials, and draws
// each answer: done, sign in with the existing login, a link no longer good,
// and unavailable, which keeps the form. Signed in, it also offers to accept
// as the signed-in person, sending the token alone with the tab's session to
// `/api/b/enrol`. The routes' own behaviour runs on the database in
// `tests/access/c39-t-enrolment.test.ts` and `c39-t-enrolment-signed-in.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { CSRF_HEADER, SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import { gateOf } from '../../apps/web/src/route-gate.ts';
import { matchRoute, pathTo } from '../../apps/web/src/routes.ts';
import { SessionStore, tabStorage, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const TOKEN = 'a'.repeat(43);
const PASSWORD = 'correct horse battery';
const SESSION_ID = 'c'.repeat(32);

function storage(seed: Record<string, string> = {}): StorageLike {
  const held = new Map(Object.entries(seed));
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

let shown: Mounted | undefined;
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
});

/** The app at an address, answering `/api/enrol` with `answer`; every request is kept. */
async function open(
  answer: { status: number; body: unknown },
  signedIn = false,
): Promise<{ view: Mounted; sent: Sent[]; went: string[] }> {
  // One app on the page at a time, as in a browser.
  await shown?.unmount();
  const sent: Sent[] = [];
  const went: string[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, init });
    if (url.endsWith('/api/enrol') || url.endsWith('/api/b/enrol')) {
      return await Promise.resolve(
        new Response(JSON.stringify(answer.body), { status: answer.status }),
      );
    }
    return await new Promise<Response>(() => {
      /* never answers */
    });
  }) as typeof globalThis.fetch;
  const seed = signedIn
    ? {
        'ops-astro.session': JSON.stringify({
          token: 't',
          businessKey: 'alpha',
          email: 'name@example.test',
          sessionId: SESSION_ID,
        }),
      }
    : {};
  const view = await mount(
    <App
      path={pathTo('agency:enrol', { token: TOKEN })}
      navigate={(next) => {
        went.push(next);
      }}
      sessions={new SessionStore(storage(seed))}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      storage={tabStorage()}
    />,
  );
  shown = view;
  return { view, sent, went };
}

async function submit(view: Mounted, password = PASSWORD): Promise<void> {
  await view.type('#enrol-password', password);
  await view.click('[data-enrol="form"] button[type="submit"]');
  await settle();
  await settle();
}

// eslint-disable-next-line max-lines-per-function -- the page's four answers, one mounted app each
describe('C39-T enrolment page', () => {
  it('C39-T enrolment page: the link opens the set-a-password form, signed in or out', async () => {
    expect(gateOf(matchRoute(`/enrol/${TOKEN}`), false)).toStrictEqual({
      kind: 'enrol',
      token: TOKEN,
    });
    for (const signedIn of [false, true]) {
      // oxlint-disable-next-line no-await-in-loop
      const { view } = await open({ status: 200, body: { state: 'enrolled' } }, signedIn);
      expect(view.find('#enrol-password'), String(signedIn)).not.toBeNull();
      expect(view.find('#signin-email'), String(signedIn)).toBeNull();
    }
  });

  it('C39-T enrolment page: the token and password go in the body, with no credentials, and the done state sends the person to sign in', async () => {
    const { view, sent, went } = await open({ status: 200, body: { state: 'enrolled' } });
    await submit(view);
    const enrol = sent.find((request) => request.url.endsWith('/api/enrol'));
    expect(enrol?.url).toBe('/api/enrol');
    expect(enrol?.init?.method).toBe('POST');
    expect(enrol?.init?.credentials).toBe('omit');
    expect(JSON.parse(String(enrol?.init?.body))).toStrictEqual({
      token: TOKEN,
      password: PASSWORD,
    });
    expect(view.find('[data-enrol="enrolled"]')).not.toBeNull();
    expect(view.find('#enrol-password')).toBeNull();
    await view.click('[data-enrol="enrolled"] button');
    expect(went).toStrictEqual([pathTo('agency:sign-in')]);
  });

  it('C39-T enrolment page: an address with a login is told to sign in with it, and a dead link is told so once', async () => {
    const existing = await open({ status: 200, body: { state: 'sign_in' } });
    await submit(existing.view);
    expect(existing.view.find('[data-enrol="sign_in"]')).not.toBeNull();
    expect(existing.view.text()).toContain('already has a login');

    const dead = await open({ status: 404, body: { code: 'ENROLMENT_LINK_INVALID' } });
    await submit(dead.view);
    expect(dead.view.find('[data-enrol="invalid"]')).not.toBeNull();
    expect(dead.view.find('[data-enrol="invalid"] button')).toBeNull();
  });

  it('C39-T enrolment page: a short password is refused at the field and nothing is sent; an unavailable provider keeps the form', async () => {
    const short = await open({ status: 200, body: { state: 'enrolled' } });
    await submit(short.view, 'short');
    expect(short.sent.filter((request) => request.url.endsWith('/api/enrol'))).toHaveLength(0);
    expect(short.view.find('#enrol-password')?.getAttribute('aria-invalid')).toBe('true');
    expect(short.view.find('#enrol-password-error')).not.toBeNull();

    const down = await open({ status: 503, body: { code: 'ENROLMENT_UNAVAILABLE' } });
    await submit(down.view);
    expect(down.view.find('#enrol-password')).not.toBeNull();
    expect(down.view.text()).toContain('Nothing changed');
  });

  it('C39-T enrolment page: signed out, no accept as anyone is offered', async () => {
    const { view } = await open({ status: 200, body: { state: 'enrolled' } });
    expect(view.find('[data-enrol="signed-in"]')).toBeNull();
  });

  it('C39-T enrolment page: signed in, the link offers to accept as the signed-in person, sends the token alone with the session, and says when they have joined', async () => {
    const { view, sent, went } = await open({ status: 200, body: { state: 'joined' } }, true);
    expect(view.text()).toContain('Accept as name@example.test');
    await view.click('[data-enrol="signed-in"] button');
    await settle();
    await settle();
    const bind = sent.find((request) => request.url.endsWith('/api/b/enrol'));
    expect(bind?.url).toBe('/api/b/enrol');
    expect(bind?.init?.method).toBe('POST');
    expect(bind?.init?.credentials).toBe('same-origin');
    expect(bind?.init?.headers).toMatchObject({ [CSRF_HEADER]: '1', [SESSION_HEADER]: SESSION_ID });
    expect(JSON.parse(String(bind?.init?.body))).toStrictEqual({ token: TOKEN });
    expect(sent.some((request) => request.url.endsWith('/api/enrol'))).toBe(false);
    expect(view.find('[data-enrol="joined"]')).not.toBeNull();
    await view.click('[data-enrol="joined"] button');
    expect(went).toStrictEqual([pathTo('agency:projects-board')]);
  });

  it('C39-T enrolment page: signed in, a link refused for this login is said once, and an ended session keeps the offer', async () => {
    const refused = await open({ status: 404, body: { code: 'ENROLMENT_LINK_INVALID' } }, true);
    await refused.view.click('[data-enrol="signed-in"] button');
    await settle();
    await settle();
    expect(refused.view.find('[data-enrol="not_yours"]')).not.toBeNull();
    expect(refused.view.find('[data-enrol="not_yours"] button')).toBeNull();

    const ended = await open({ status: 401, body: { code: 'AUTH_SESSION_EXPIRED' } }, true);
    await ended.view.click('[data-enrol="signed-in"] button');
    await settle();
    await settle();
    expect(ended.view.find('[data-enrol="signed-in"]')).not.toBeNull();
    expect(ended.view.text()).toContain('Your sign-in has ended');
  });
});
