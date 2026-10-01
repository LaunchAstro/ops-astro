// @vitest-environment jsdom
/* eslint-disable max-lines -- one set-up's cases on Settings, sharing one stand-in API */
// SPDX-License-Identifier: AGPL-3.0-only
//
// "Set up an authenticator app" on Settings ▸ General (C59): a person enrols
// the second factor the money step-up asks for. The enrol is the person's own
// account route with an empty body; its answer (the QR, the secret, the uri)
// is drawn once and kept nowhere else. The first good code goes through the
// application's one step-up (`session/step-up.ts`): verified, its token traded
// for a new cookie, the tab moved to it and the old cookie cleared. The
// server's half (the routes, the sixty-minute fresh sign-in, the other
// sessions ended) is its own suites'; here the stand-in is the transport.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER, SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import { json, open, settle } from './mp-2-1-support.tsx';
import type { Mounted } from '../surfaces/mount.tsx';

const CANARY = 'ENROL-CANARY-SHOWN-ONCE';
const URI = `otpauth://totp/Ops%20Astro:mia%40alpha.local?secret=${CANARY}&issuer=Ops%20Astro`;
const SVG_QR = `data:image/svg+xml;utf-8,<svg xmlns="http://www.w3.org/2000/svg"><title>${CANARY}</title></svg>`;
const AAL2 = 'tok-enrol-aal2-secret';
const REFRESH = 'refresh-enrol-aal2-secret';

const issued = (qrCode = SVG_QR) => ({ factorId: 'factor-1', qrCode, secret: CANARY, uri: URI });

const refusal = (code: string, fixes: readonly string[], status = 403): Response =>
  json({ refused: true, code, names: [], fixes }, status);

const never = (): Promise<Response> =>
  new Promise<Response>(() => {
    /* never answers */
  });

interface Call {
  readonly url: string;
  readonly session: string | null;
  readonly authorization: string | null;
  readonly csrf: string | null;
  readonly body: Readonly<Record<string, unknown>>;
}

interface Options {
  /** What the enrol route answers; a fresh factor with an SVG QR by default. */
  readonly enrol?: () => Promise<Response>;
}

const goodVerify = (code: unknown): Response =>
  code === '123456'
    ? json({ accessToken: AAL2, refreshToken: REFRESH, expiresIn: 3600 })
    : refusal('SECOND_FACTOR_INVALID', ['Check the code in your authenticator app and retry.']);

/** The API Settings meets, signed in as `sid-old`. */
function api(options: Options = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      session: headers.get(SESSION_HEADER),
      authorization: headers.get('authorization'),
      csrf: headers.get(CSRF_HEADER),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    calls.push(call);
    if (url === '/api/session') {
      return call.authorization === `Bearer ${AAL2}`
        ? json({ ok: true, session: 'sid-new' })
        : refusal('AUTH_UNKNOWN_LOGIN', [], 401);
    }
    if (url === '/api/session/end') return json({ ok: true });
    if (url.endsWith('/account/factor/enrol')) {
      return options.enrol === undefined ? json(issued()) : await options.enrol();
    }
    if (url.endsWith('/account/factor/verify')) return goodVerify(call.body['code']);
    if (url.endsWith('/account/sessions/list')) return json({ sessions: [] });
    if (url.endsWith('/settings/read')) {
      return json({
        ok: true,
        settings: [],
        planningCap: { limitMinor: 5_000, currency: 'AUD', set: false },
      });
    }
    if (url.endsWith('/session/capabilities')) {
      return json({ ok: true, personId: 'p-mia', businessKey: 'alpha', grants: [] });
    }
    if (url.endsWith('/session/person')) return json({ person: { name: 'Mia Hart' } });
    calls.pop();
    return await never();
  }) as unknown as typeof globalThis.fetch;
  const to = (suffix: string): Call[] => calls.filter((call) => call.url.endsWith(suffix));
  return { fetch, calls, to };
}

const SIGNED_IN = {
  'ops-astro.session': JSON.stringify({
    businessKey: 'alpha',
    email: 'mia@alpha.local',
    sessionId: 'sid-old',
  }),
};

const PANEL = '[data-factor="panel"]';

const unanswered = (): void => {};

const live: Mounted[] = [];
afterEach(async () => {
  for (const view of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await view.unmount();
  }
  vi.restoreAllMocks();
});

type Spy = { readonly mock: { readonly calls: readonly (readonly unknown[])[] } };
const spies: Spy[] = [];
/** Everything written to storage or the console since the case began. */
const written = (): string[] =>
  spies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(' ')));
beforeEach(() => {
  spies.length = 0;
  spies.push(vi.spyOn(Storage.prototype, 'setItem'));
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    spies.push(vi.spyOn(console, method));
  }
});

/** Settings opened and "Set up authenticator app" pressed. */
async function enrolled(options: Options = {}) {
  const server = api(options);
  const opened = await open('/settings', { fetch: server.fetch, seed: SIGNED_IN });
  live.push(opened.view);
  await settle();
  await opened.view.click(`${PANEL} [data-factor="enrol"] button`);
  await settle();
  return { ...opened, server };
}

async function enter(view: Mounted, code: string): Promise<void> {
  await view.type(`${PANEL} [data-step-up="code"]`, code);
  await view.click(`${PANEL} [data-factor="confirm"] button`);
  await settle();
}

/** None of the issued factor's secrets is anywhere a person or a script could find it later. */
function expectNothingKept(opened: { held: Map<string, string>; seen: string[] }): void {
  const kept = [
    ...written(),
    JSON.stringify([...opened.held.entries()]),
    JSON.stringify({ ...window.sessionStorage }),
    JSON.stringify({ ...window.localStorage }),
    window.location.href,
    ...opened.seen,
  ].join('\n');
  for (const secret of [CANARY, URI, 'otpauth', AAL2, REFRESH]) expect(kept).not.toContain(secret);
}

function expectNoneDrawn(view: Mounted): void {
  const drawn = view.host.ownerDocument.body.innerHTML;
  for (const secret of [CANARY, URI, 'otpauth', 'data:image/svg+xml'])
    expect(drawn.includes(secret), `${secret} still drawn`).toBe(false);
}

// eslint-disable-next-line max-lines-per-function -- one case per part of the set-up
describe('authenticator set-up', () => {
  it('authenticator set-up: the control sits beside Your sessions and posts account/factor/enrol with {}', async () => {
    const { view, server } = await enrolled();
    expect(view.find(`${PANEL}`)).not.toBeNull();
    expect(view.find('[data-sessions="panel"]')).not.toBeNull();
    const enrol = server.to('/account/factor/enrol');
    expect(enrol).toStrictEqual([
      {
        url: '/api/b/alpha/account/factor/enrol',
        session: 'sid-old',
        authorization: null,
        csrf: '1',
        body: {},
      },
    ]);
  });

  it('authenticator set-up: draws an SVG QR as an image, the secret as text and a one-time-code field', async () => {
    const { view } = await enrolled();
    const image = view.find(`${PANEL} img[data-factor="qr"]`);
    expect(image?.getAttribute('src')).toBe(SVG_QR);
    expect(image?.getAttribute('alt')).not.toBe('');
    expect(view.find(`${PANEL} [data-factor="secret"]`)?.textContent).toBe(CANARY);
    const field = view.find(`${PANEL} [data-step-up="code"]`) as HTMLInputElement | null;
    expect(field?.getAttribute('autocomplete')).toBe('one-time-code');
    expect(field?.getAttribute('inputmode')).toBe('numeric');
    expect(field?.maxLength).toBe(6);
    // The uri is never drawn: the QR and the secret carry it.
    expect(document.body.innerHTML).not.toContain('otpauth');
  });

  it('authenticator set-up: a QR that is not an SVG data URL draws no image and still shows the secret', async () => {
    for (const qrCode of [
      'data:image/png;base64,iVBORw0KGgo=',
      'https://tracker.invalid/qr.svg',
      'javascript:alert(1)',
      ' data:image/svg+xml;utf-8,<svg/>',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one mounted App at a time
      const { view } = await enrolled({ enrol: () => Promise.resolve(json(issued(qrCode))) });
      expect(view.find(`${PANEL} img`), qrCode).toBeNull();
      expect(document.body.innerHTML, qrCode).not.toContain(qrCode.trim());
      expect(view.find(`${PANEL} [data-factor="secret"]`)?.textContent, qrCode).toBe(CANARY);
      // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
      await live.pop()?.unmount();
    }
  });

  it('authenticator set-up: a good first code verifies, trades for a new cookie, moves the tab to it and ends the old one, then the secret is gone and it says set up', async () => {
    const opened = await enrolled();
    const { view, server, sessions } = opened;
    await enter(view, '123456');

    expect(server.to('/account/factor/verify')).toMatchObject([
      { url: '/api/b/alpha/account/factor/verify', session: 'sid-old', body: { code: '123456' } },
    ]);
    const trade = server.calls.filter((call) => call.url === '/api/session');
    expect(trade).toStrictEqual([
      { url: '/api/session', session: null, authorization: `Bearer ${AAL2}`, csrf: '1', body: {} },
    ]);
    const ended = server.calls.filter((call) => call.url === '/api/session/end');
    expect(ended.map((call) => call.session)).toStrictEqual(['sid-old']);
    expect(sessions.session?.sessionId).toBe('sid-new');

    expectNoneDrawn(view);
    expect(view.find(`${PANEL} [data-step-up="code"]`)).toBeNull();
    expect(view.find(`${PANEL} [data-factor="done"]`)?.textContent).toContain(
      'Your authenticator app is set up.',
    );
    expectNothingKept(opened);
  });

  it('authenticator set-up never: keeps the secret, QR or uri in storage, the URL or the console, and cancel drops them and sends nothing more', async () => {
    const opened = await enrolled();
    const { view, server } = opened;
    expect(view.find(`${PANEL} [data-factor="secret"]`)?.textContent).toBe(CANARY);
    await enter(view, '000000');
    expect(view.find(`${PANEL} [role="alert"]`)?.textContent ?? '').not.toContain(CANARY);
    expectNothingKept(opened);
    const before = server.calls.length;
    await view.click(`${PANEL} [data-factor="cancel"] button`);
    await settle();
    expectNoneDrawn(view);
    expect(view.find(`${PANEL} [data-factor="enrol"] button`)).not.toBeNull();
    expect(server.calls.length).toBe(before);
    expectNothingKept(opened);
  });

  it('authenticator set-up never: draws an answer that lands after cancel', async () => {
    let answer: (response: Response) => void = unanswered;
    const enrol = (): Promise<Response> =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      });
    const opened = await enrolled({ enrol });
    const { view, server } = opened;
    await view.click(`${PANEL} [data-factor="cancel"] button`);
    answer(json(issued()));
    await settle();
    expectNoneDrawn(view);
    expect(server.to('/account/factor/verify')).toEqual([]);
  });

  it('authenticator set-up never: leaves the secret behind once the page is left', async () => {
    const opened = await enrolled();
    expect(opened.view.find(`${PANEL} [data-factor="secret"]`)?.textContent).toBe(CANARY);
    await opened.view.unmount();
    live.splice(live.indexOf(opened.view), 1);
    expectNoneDrawn(opened.view);
    expectNothingKept(opened);
  });

  it('authenticator set-up: a wrong code shows the server’s words and keeps the set-up open for another try', async () => {
    const opened = await enrolled();
    const { view, server, sessions } = opened;
    await enter(view, '000000');
    const alert = view.find(`${PANEL} [role="alert"]`)?.textContent ?? '';
    expect(alert).toContain('SECOND_FACTOR_INVALID');
    expect(alert).toContain('Check the code in your authenticator app and retry.');
    expect(view.find(`${PANEL} [data-factor="secret"]`)?.textContent).toBe(CANARY);
    expect(server.calls.filter((call) => call.url === '/api/session')).toEqual([]);
    await enter(view, '123456');
    expect(server.to('/account/factor/verify')).toHaveLength(2);
    expect(sessions.session?.sessionId).toBe('sid-new');
    expect(view.find(`${PANEL} [data-factor="done"]`)).not.toBeNull();
  });

  it('authenticator set-up: the enrol’s refusals are drawn in the server’s words', async () => {
    const cases: ReadonlyArray<readonly [string, string, number]> = [
      [
        'FRESH_SIGN_IN_REQUIRED',
        'Sign in again with your password, then set up the authenticator app within 60 minutes.',
        403,
      ],
      [
        'FACTOR_ALREADY_ENROLLED',
        'You already have an authenticator app. To replace it, remove it with a code from it first.',
        409,
      ],
      ['COMMAND_BODY_INVALID', 'Send only { "code": "<the six digits>" }.', 400],
    ];
    for (const [code, fix, status] of cases) {
      const enrol = (): Promise<Response> => Promise.resolve(refusal(code, [fix], status));
      // eslint-disable-next-line no-await-in-loop -- one mounted App at a time
      const { view, server } = await enrolled({ enrol });
      const said = view.find(`${PANEL} [data-factor="outcome"]`)?.textContent ?? '';
      expect(said, code).toContain(code);
      expect(said, code).toContain(fix);
      expect(view.find(`${PANEL} [data-step-up="code"]`), code).toBeNull();
      expect(server.to('/account/factor/verify'), code).toEqual([]);
      // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
      await live.pop()?.unmount();
    }
  });
});
