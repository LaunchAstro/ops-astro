// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The client's money step-up through the real application (C59, Q1): `App.tsx`
// provides the password sign-in again, so a planning cap refused
// `STEP_UP_REQUIRED` naming `sign_in` asks for the password, and a good one
// moves the tab to a new sign-in and sends the write once more. The prompt's
// cases are `money-sign-in-again.test.tsx`'s, drawn in a stand-in application.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { json, open, settle } from './mp-2-1-support.tsx';
import { EMAIL, FRESH, GOTRUE, PASSWORD, goodPassword, refusal } from './sign-in-again-support.tsx';

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

/** The API and GoTrue a client meets, signed in as `sid-old`, its money writes asking the step-up. */
function api() {
  const calls: Sent[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const session = headers.get(SESSION_HEADER);
    calls.push({ url, session, authorization: headers.get('authorization') });
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
