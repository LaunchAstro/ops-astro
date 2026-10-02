// @vitest-environment jsdom
/* eslint-disable max-lines -- one prompt's cases on its two screens, sharing one stand-in API */
// SPDX-License-Identifier: AGPL-3.0-only
//
// The money step-up prompt (C59; ORCH62 (3)): `budget.set_planning_cap` and
// `run.top_up` refused `STEP_UP_REQUIRED` ask for the authenticator code in
// one shared prompt. A good code is checked on the person's own account route,
// its token traded for a new session cookie the way sign-in trades one, the tab
// moves to that session and clears the old cookie, and the command goes once
// more on the new session. Nothing else is kept and nothing signs out. The
// server's half (the verify route, the cookie trade, the sixty-minute judge)
// is its own suites'; here the stand-in is the transport.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER, SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import { json, open, settle } from './mp-2-1-support.tsx';
import type { Mounted } from '../surfaces/mount.tsx';

const TASK_ID = '66666666-6666-4666-8666-666666666666';
const RUN_ID = '88888888-8888-4888-8888-888888888888';
const AAL2 = 'tok-aal2-secret';
const REFRESH = 'refresh-aal2-secret';

const never = (): Promise<Response> =>
  new Promise<Response>(() => {
    /* never answers */
  });

const refusal = (code: string, fixes: readonly string[], status = 403): Response =>
  json({ refused: true, code, names: [], fixes }, status);

const STEP_UP = [
  'Sign in again with the code from your authenticator app, then retry.',
  'A money action needs a sign-in with the second factor in the last 60 minutes.',
];

interface Call {
  readonly url: string;
  readonly session: string | null;
  readonly authorization: string | null;
  readonly csrf: string | null;
  readonly body: Readonly<Record<string, unknown>>;
}

interface Options {
  /** What the verify route answers; a good `123456` by default. */
  readonly verify?: (code: unknown) => Promise<Response>;
  /** What the cookie trade answers; the new session by default. */
  readonly trade?: () => Promise<Response>;
  /** The new session is refused the step-up too. */
  readonly stillRefused?: boolean;
}

/** One approved run, so the Agent pane draws its run and the stop on it (as `c54-page.tsx`). */
const lineage = {
  lineageId: 'l-54',
  state: 'live',
  versions: [
    {
      versionId: 'v-54',
      version: 1,
      purpose: 'send_the_reply',
      maximumMinor: 1_800,
      currency: 'AUD',
      payloadDigest: 'digest-54',
      payload: {},
      supersededAt: null,
      runId: RUN_ID,
      checks: [],
      evidence: null,
      gate: {
        id: 'g-54',
        state: 'approved',
        round: 0,
        expiresAt: '2026-10-01T00:00:00.000Z',
        expired: false,
        payloadDigest: 'digest-54',
      },
    },
  ],
  decisions: [],
  reservations: [],
};

const task = {
  id: TASK_ID,
  key: 'TSK-54',
  title: 'A run stopped at its budget',
  description: null,
  state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 3,
  history: [],
  comments: [],
  proposals: [lineage],
  ledger: {
    envelopes: [],
    stops: [
      {
        askId: 'ask-1',
        runId: RUN_ID,
        number: 1,
        kind: 'stop',
        ceilingMinor: 400,
        spentMinor: 390,
        currency: 'AUD',
        raisedAt: '2026-09-30T01:00:00.000Z',
        answer: null,
        awaitingSecond: null,
      },
    ],
  },
};

const goodVerify = (code: unknown): Promise<Response> =>
  Promise.resolve(
    code === '123456'
      ? json({ accessToken: AAL2, refreshToken: REFRESH, expiresIn: 3600 })
      : refusal('SECOND_FACTOR_INVALID', ['Check the code in your authenticator app and retry.']),
  );

/** The API the tab meets, signed in as `sid-old`, whose money commands ask the step-up. */
// eslint-disable-next-line max-lines-per-function -- every route the two screens call
function api(options: Options = {}) {
  const calls: Call[] = [];
  const money = (call: Call): Response =>
    call.session === 'sid-new' && options.stillRefused !== true
      ? json({ recordId: TASK_ID, revision: null, detail: { state: 'applied' } })
      : refusal('STEP_UP_REQUIRED', STEP_UP);
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
      if (options.trade !== undefined) return await options.trade();
      return call.authorization === `Bearer ${AAL2}`
        ? json({ ok: true, session: 'sid-new' })
        : refusal('AUTH_UNKNOWN_LOGIN', [], 401);
    }
    if (url === '/api/session/end') return json({ ok: true });
    if (url.endsWith('/account/factor/verify')) {
      return await (options.verify ?? goodVerify)(call.body['code']);
    }
    if (url.endsWith('/budget/set_planning_cap') || url.endsWith('/run/top_up')) {
      return money(call);
    }
    if (url.endsWith('/settings/read')) {
      return json({
        ok: true,
        settings: [],
        planningCap: { limitMinor: 5_000, currency: 'AUD', set: false },
      });
    }
    if (url.endsWith('/session/capabilities')) {
      return json({
        ok: true,
        personId: 'p-mia',
        businessKey: 'alpha',
        grants: [{ collection: 'billing', action: 'decide' }],
      });
    }
    if (url.endsWith('/task/read')) return json({ ok: true, task });
    if (url.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (url.endsWith('/session/person')) return json({ person: { name: 'Mia Hart' } });
    if (url.endsWith('/account/sessions/sign-out')) return json({ ok: true });
    if (url.endsWith('/session/end')) return json({ recordId: null, detail: {} });
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

const PROMPT = '[data-step-up="prompt"]';
const promptIn = (view: Mounted): Element | null => view.find('[data-step-up="prompt"]');

const unanswered = (): void => {};

const live: Mounted[] = [];
afterEach(async () => {
  for (const view of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await view.unmount();
  }
});
const CAP_WRITE = '/budget/set_planning_cap';

/** The planning cap saved at AUD 75 and refused the step-up. */
async function capRefused(options: Options = {}) {
  const server = api(options);
  const opened = await open('/settings', { fetch: server.fetch, seed: SIGNED_IN });
  live.push(opened.view);
  await settle();
  await opened.view.type('#settings-planning-cap', '75');
  await opened.view.click('[data-settings="save-planning-cap"]');
  await settle();
  return { ...opened, server };
}

/** The agent pane's top-up of AUD 2.50 at the budget stop, refused the step-up. */
async function topUpRefused(options: Options = {}) {
  const server = api(options);
  const opened = await open('/task/TSK-54', { fetch: server.fetch, seed: SIGNED_IN });
  live.push(opened.view);
  await settle();
  await opened.view.type('[data-section="agent"] [data-stop="amount"]', '2.50');
  await opened.view.click('[data-section="agent"] [data-stop="top-up"]');
  await settle();
  return { ...opened, server };
}

async function enter(view: Mounted, code: string): Promise<void> {
  await view.type(`${PROMPT} [data-step-up="code"]`, code);
  await view.click(`${PROMPT} [data-step-up="confirm"]`);
  await settle();
}

const withoutAttempt = (body: Readonly<Record<string, unknown>>) => {
  const { operationId: _attempt, ...rest } = body;
  return rest;
};

// eslint-disable-next-line max-lines-per-function -- one case per part of the step-up
describe('money step-up prompt', () => {
  it('money step-up: the planning cap refused STEP_UP_REQUIRED asks for the authenticator code', async () => {
    const { view } = await capRefused();
    const prompt = view.find(`[data-settings="planning-cap"] ${PROMPT}`);
    expect(prompt).not.toBeNull();
    const field = view.find(`${PROMPT} [data-step-up="code"]`) as HTMLInputElement | null;
    expect(field?.getAttribute('autocomplete')).toBe('one-time-code');
    expect(field?.getAttribute('inputmode')).toBe('numeric');
    expect(field?.maxLength).toBe(6);
  });

  it('money step-up: the agent pane’s top-up at a budget stop shows the same prompt', async () => {
    const { view } = await topUpRefused();
    const prompt = view.find(`[data-section="agent"] ${PROMPT}`);
    expect(prompt).not.toBeNull();
    expect(prompt?.querySelector('[data-step-up="code"]')?.getAttribute('autocomplete')).toBe(
      'one-time-code',
    );
  });

  it('money step-up: a good code verifies, trades for a new cookie, moves the tab to it, ends the old one and resends the planning cap once', async () => {
    const { view, server, sessions, seen } = await capRefused();
    const navigated = seen.length;
    await enter(view, '123456');

    const verify = server.to('/account/factor/verify');
    expect(verify).toHaveLength(1);
    expect(verify[0]).toMatchObject({
      url: '/api/b/alpha/account/factor/verify',
      session: 'sid-old',
      csrf: '1',
      body: { code: '123456' },
    });
    const trade = server.calls.filter((call) => call.url === '/api/session');
    expect(trade).toStrictEqual([
      { url: '/api/session', session: null, authorization: `Bearer ${AAL2}`, csrf: '1', body: {} },
    ]);
    const ended = server.calls.filter((call) => call.url === '/api/session/end');
    expect(ended.map((call) => call.session)).toStrictEqual(['sid-old']);

    const writes = server.to(CAP_WRITE);
    expect(writes.map((call) => call.session)).toStrictEqual(['sid-old', 'sid-new']);
    expect(withoutAttempt(writes[1]?.body ?? {})).toStrictEqual(
      withoutAttempt(writes[0]?.body ?? {}),
    );
    expect(writes[1]?.body).toMatchObject({ limitMinor: 7_500, fromLimitMinor: 5_000 });
    // The order: verify, trade, the old cookie ended, then the resend.
    const order = server.calls.map((call) => call.url);
    expect(order.indexOf('/api/session')).toBeGreaterThan(order.indexOf(verify[0]?.url ?? ''));
    expect(order.lastIndexOf('/api/b/alpha/budget/set_planning_cap')).toBeGreaterThan(
      order.indexOf('/api/session/end'),
    );

    expect(sessions.session?.sessionId).toBe('sid-new');
    expect(seen.length).toBe(navigated);
    expect(promptIn(view)).toBeNull();
  });

  it('money step-up: a good code resends the agent pane’s top-up once, on the new session', async () => {
    const { view, server } = await topUpRefused();
    await enter(view, '123456');
    const writes = server.to('/run/top_up');
    expect(writes.map((call) => call.session)).toStrictEqual(['sid-old', 'sid-new']);
    expect(withoutAttempt(writes[1]?.body ?? {})).toStrictEqual({
      recordId: TASK_ID,
      runId: RUN_ID,
      askId: 'ask-1',
      amountMinor: 250,
      currency: 'AUD',
    });
    expect(promptIn(view)).toBeNull();
  });

  it('money step-up never: keeps a token, calls the provider sign-out, or resends a second time', async () => {
    const { view, server, held } = await capRefused({ stillRefused: true });
    await enter(view, '123456');
    await settle();
    expect(server.to(CAP_WRITE)).toHaveLength(2);
    const kept = JSON.stringify([...held.entries()]);
    expect(kept).not.toContain(AAL2);
    expect(kept).not.toContain(REFRESH);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(AAL2);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(AAL2);
    const urls = server.calls.map((call) => call.url);
    expect(urls.filter((url) => url.includes('sign-out') || url.includes('logout'))).toEqual([]);
  });

  it('money step-up never: resends without a successful trade', async () => {
    const trade = (): Promise<Response> =>
      Promise.resolve(refusal('AUTH_UNKNOWN_LOGIN', ['Sign in again.'], 401));
    const { view, server, sessions } = await capRefused({ trade });
    await enter(view, '123456');
    expect(server.to(CAP_WRITE)).toHaveLength(1);
    expect(server.calls.filter((call) => call.url === '/api/session/end')).toStrictEqual([]);
    expect(sessions.session?.sessionId).toBe('sid-old');
    expect(view.find(`${PROMPT} [role="alert"]`)?.textContent ?? '').not.toBe('');
  });

  it('money step-up never: resends after the session ended while the code was checked', async () => {
    let answer: (response: Response) => void = unanswered;
    const verify = (): Promise<Response> =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      });
    const { view, server } = await capRefused({ verify });
    await enter(view, '123456');
    await view.click('.appbar .who__trigger');
    await view.click('.who__menu button[role="menuitem"]');
    await settle();
    answer(json({ accessToken: AAL2, refreshToken: REFRESH, expiresIn: 3600 }));
    await settle();
    expect(server.calls.filter((call) => call.authorization === `Bearer ${AAL2}`)).toEqual([]);
    expect(server.to(CAP_WRITE)).toHaveLength(1);
  });

  it('money step-up: a wrong code shows the server’s words in the prompt and resends nothing', async () => {
    const { view, server } = await capRefused();
    await enter(view, '000000');
    expect(view.find(`${PROMPT} [role="alert"]`)?.textContent).toContain('SECOND_FACTOR_INVALID');
    expect(view.find(`${PROMPT} [role="alert"]`)?.textContent).toContain(
      'Check the code in your authenticator app and retry.',
    );
    expect(server.calls.filter((call) => call.url === '/api/session')).toEqual([]);
    expect(server.to(CAP_WRITE)).toHaveLength(1);
  });

  it('money step-up: FACTOR_NOT_ENROLLED shows the server’s words and resends nothing', async () => {
    const verify = (): Promise<Response> =>
      Promise.resolve(refusal('FACTOR_NOT_ENROLLED', ['Set up an authenticator app first.']));
    const { view, server } = await topUpRefused({ verify });
    await enter(view, '123456');
    expect(view.find(`${PROMPT} [role="alert"]`)?.textContent).toContain(
      'Set up an authenticator app first.',
    );
    expect(server.to('/run/top_up')).toHaveLength(1);
  });

  it('money step-up: cancel closes the prompt and resends nothing', async () => {
    const { view, server } = await capRefused();
    await view.click(`${PROMPT} [data-step-up="cancel"]`);
    await settle();
    expect(promptIn(view)).toBeNull();
    expect(server.to('/account/factor/verify')).toEqual([]);
    expect(server.to(CAP_WRITE)).toHaveLength(1);
  });

  it('money step-up: the code is six digits before it can be sent', async () => {
    const { view, server } = await capRefused();
    const confirm = (): HTMLButtonElement | null =>
      view.find(`${PROMPT} [data-step-up="confirm"]`) as HTMLButtonElement | null;
    for (const typed of ['', '12345', 'abcdef', '1234567']) {
      // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
      await view.type(`${PROMPT} [data-step-up="code"]`, typed);
      expect(confirm()?.disabled, typed).toBe(true);
    }
    expect(server.to('/account/factor/verify')).toEqual([]);
  });
});
