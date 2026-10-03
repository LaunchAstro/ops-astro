// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The client's money step-up through the real application (C59, Q1): `App.tsx`
// provides the password sign-in again, so a planning cap refused
// `STEP_UP_REQUIRED` naming `sign_in` asks for the password, and a good one
// moves the tab to a new sign-in and sends the write once more. The prompt's
// cases are `money-sign-in-again.test.tsx`'s, drawn in a stand-in application.
// Of two sign-ins again at once, only the one that still holds the tab's
// session is adopted: the identity check in `App.tsx`, which the generation
// alone does not cover.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { json, open, settle } from './mp-2-1-support.tsx';
import {
  EMAIL,
  FRESH,
  FRESH_REFRESH,
  GOTRUE,
  PASSWORD,
  goodPassword,
  held,
  refusal,
} from './sign-in-again-support.tsx';

const WRITE = '/budget/set_planning_cap';
const PROMPT = '[data-step-up="prompt"]';
const SIGN_IN = [
  'Sign in again with your password, then retry.',
  'A money action needs a sign-in in the last 60 minutes.',
];

interface Sent {
  readonly url: string;
  readonly session: string | null;
  readonly authorization: string | null;
}

/** A case's own answer to a call, or null to leave it to the shared routes. */
type Own = (call: Sent) => Promise<Response> | null;

/** The API and GoTrue a client meets, signed in as `sid-old`, its money writes asking the step-up. */
function api(own: Own = () => null) {
  const calls: Sent[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const session = headers.get(SESSION_HEADER);
    const call = { url, session, authorization: headers.get('authorization') };
    calls.push(call);
    const answered = own(call);
    if (answered !== null) return await answered;
    if (url === `${GOTRUE}/token?grant_type=password`) return await goodPassword(body);
    if (url === '/api/session') {
      return headers.get('authorization') === `Bearer ${FRESH}`
        ? json({ ok: true, session: 'sid-new' })
        : refusal('AUTH_UNKNOWN_LOGIN', [], 401);
    }
    if (url === '/api/session/end') return json({ ok: true });
    if (url === `${GOTRUE}/logout?scope=local`) return new Response(null, { status: 204 });
    if (url.endsWith('/account/sessions/sign-out')) return json({ ok: true });
    if (url.endsWith(WRITE)) {
      return session === 'sid-new'
        ? json({ recordId: null, revision: null, detail: { state: 'applied' } })
        : refusal('STEP_UP_REQUIRED', SIGN_IN, 403, ['sign_in']);
    }
    if (url.endsWith('/settings/read')) {
      const planningCap = { limitMinor: 5_000, currency: 'AUD', set: false };
      return json({ ok: true, settings: [], planningCap });
    }
    if (url.endsWith('/session/capabilities')) {
      const grants = [{ collection: 'billing', action: 'decide' }];
      return json({ ok: true, personId: 'p-cleo', businessKey: 'alpha', grants });
    }
    calls.pop();
    return await new Promise<Response>(() => {
      /* never answers */
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, to: (suffix: string) => calls.filter((c) => c.url.endsWith(suffix)) };
}

const SIGNED_IN = {
  'ops-astro.session': JSON.stringify({ businessKey: 'alpha', email: EMAIL, sessionId: 'sid-old' }),
};

const live: Mounted[] = [];
afterEach(async () => {
  for (const view of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await view.unmount();
  }
});

describe('the application signs a client in again at the money step-up', () => {
  it('money sign-in again in the app: a client’s planning cap goes through after a password sign-in', async () => {
    const server = api();
    const { view, sessions } = await open('/settings', { fetch: server.fetch, seed: SIGNED_IN });
    live.push(view);
    await settle();
    await view.type('#settings-planning-cap', '75');
    await view.click('[data-settings="save-planning-cap"]');
    await settle();
    expect(view.find(`${PROMPT}`)).not.toBeNull();
    expect(view.find(`${PROMPT} [data-step-up="password"]`)).not.toBeNull();

    await view.type(`${PROMPT} [data-step-up="password"]`, PASSWORD);
    await view.click(`${PROMPT} [data-step-up="confirm"]`);
    await settle();

    const toGoTrue = server.calls.filter((call) => call.url.startsWith(GOTRUE));
    expect(toGoTrue.map((call) => call.url)).toEqual([`${GOTRUE}/token?grant_type=password`]);
    const trades = server.calls.filter((call) => call.url === '/api/session');
    expect(trades.map((call) => call.authorization)).toEqual([`Bearer ${FRESH}`]);
    expect(server.to(WRITE).map((call) => call.session)).toEqual(['sid-old', 'sid-new']);
    expect(sessions.session?.sessionId).toBe('sid-new');
    const ended = server.calls.filter((call) => call.url === '/api/session/end');
    expect(ended.map((call) => call.session)).toEqual(['sid-old']);
    expect(view.find(`${PROMPT}`)).toBeNull();
  });
});

/** The enrol asks a fresh sign-in; the first password grant waits, the second signs in as `sid-B`. */
function twoSignIns(first: ReturnType<typeof held>) {
  const grants: Sent[] = [];
  const own: Own = (call) => {
    if (call.url === `${GOTRUE}/token?grant_type=password`) {
      grants.push(call);
      if (grants.length === 1) return first.wait();
      return Promise.resolve(
        json({ access_token: 'tok-two', refresh_token: 'r', expires_in: 3600 }),
      );
    }
    if (call.url === '/api/session' && call.authorization === 'Bearer tok-two') {
      return Promise.resolve(json({ ok: true, session: 'sid-B' }));
    }
    if (call.url.endsWith('/account/factor/enrol') && call.session === 'sid-old') {
      return Promise.resolve(refusal('FRESH_SIGN_IN_REQUIRED', ['Sign in again.'], 403));
    }
    return null;
  };
  return { own, grants };
}

describe('two sign-ins again at once on the settings page', () => {
  it('money sign-in again in the app: of two sign-ins at once the later one keeps the tab, and the earlier is signed out at GoTrue', async () => {
    const first = held();
    const race = twoSignIns(first);
    const server = api(race.own);
    const { view, sessions } = await open('/settings', { fetch: server.fetch, seed: SIGNED_IN });
    live.push(view);
    await settle();
    await view.type('#settings-planning-cap', '75');
    await view.click('[data-settings="save-planning-cap"]');
    await view.click('[data-factor="panel"] [data-factor="enrol"] button');
    await settle();

    await view.type(`${PROMPT} [data-step-up="password"]`, PASSWORD);
    await view.click(`${PROMPT} [data-step-up="confirm"]`);
    await settle();
    await view.type('[data-factor="panel"] [data-factor="password"]', PASSWORD);
    await view.click('[data-factor="panel"] [data-factor="sign-in"] button');
    await settle();
    first.answer(json({ access_token: FRESH, refresh_token: FRESH_REFRESH, expires_in: 3600 }));
    await settle();

    expect(race.grants).toHaveLength(2);
    expect(sessions.session?.sessionId).toBe('sid-B');
    const logouts = server.calls.filter((call) => call.url === `${GOTRUE}/logout?scope=local`);
    expect(logouts.map((call) => call.authorization)).toEqual([`Bearer ${FRESH}`]);
    const ended = server.calls.filter((call) => call.url === '/api/session/end');
    expect(ended.map((call) => call.session)).toEqual(['sid-old']);
  });
});
