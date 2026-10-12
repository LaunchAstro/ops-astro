// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's budget top-up (T2e) is a money write (C59). Refused
// `STEP_UP_REQUIRED`, it opens the code prompt, and the prompt belongs to the
// page, not to the control a reread unmounts: a reread that starts while the
// prompt is open, and stalls, leaves the prompt where it was. A good code then
// sends the same top-up once more, on the stepped-up sign-in, under the same
// operation id and with the same figures. Drives the whole application, so
// the step-up, the cookie trade and the client rebuilt for the new sign-in
// are the real ones.

import { afterEach, expect, it } from 'vitest';
import { SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import { json, open, settle } from './mp-2-1-support.tsx';
import type { Mounted } from '../surfaces/mount.tsx';

const TASK_ID = '44444444-4444-4444-8444-444444444444';
const AAL2 = 'tok-aal2-top-up';
const PROMPT = '[data-step-up="prompt"]';

const task = {
  id: TASK_ID,
  key: 'TSK-41',
  title: 'A task with an approved plan',
  description: null,
  state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 3,
  history: [],
  comments: [],
  proposals: [],
  envelope: { id: 'env-1', maximumMinor: 250_000, heldMinor: 0, actualMinor: 0, currency: 'AUD' },
};

const never = (): Promise<Response> =>
  new Promise<Response>(() => {
    /* never answers */
  });

interface TopUpCall {
  readonly session: string | null;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * The API the tab meets, signed in as `sid-old`; later task reads wait for
 * `release`, and with `loseResend` the stepped-up resend's answer is lost.
 */
// eslint-disable-next-line max-lines-per-function -- every route the task page and the step-up call
function api(loseResend = false) {
  const topUps: TopUpCall[] = [];
  let reads = 0;
  const stalled: { release?: () => void } = {};
  const held = new Promise<void>((resolve) => {
    stalled.release = resolve;
  });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const session = new Headers(init?.headers).get(SESSION_HEADER);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.endsWith('/task/read')) {
      reads += 1;
      if (reads > 1) await held;
      return json({ ok: true, task });
    }
    if (url.endsWith('/budget/top_up')) {
      topUps.push({ session, body });
      if (loseResend && topUps.length === 2) throw new TypeError('The answer was lost');
      return session === 'sid-new'
        ? json({ recordId: TASK_ID, revision: null, detail: { state: 'applied' } })
        : json({ refused: true, code: 'STEP_UP_REQUIRED', names: [], fixes: [] }, 403);
    }
    if (url.endsWith('/account/factor/verify')) {
      return json({ accessToken: AAL2, refreshToken: 'refresh', expiresIn: 3600 });
    }
    if (url === '/api/session') return json({ ok: true, session: 'sid-new' });
    if (url === '/api/session/end') return json({ ok: true });
    if (url.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (url.endsWith('/session/person')) return json({ person: { name: 'Mia Hart' } });
    if (url.endsWith('/session/capabilities')) {
      return json({
        ok: true,
        personId: 'p-mia',
        businessKey: 'alpha',
        grants: [{ collection: 'billing', action: 'decide' }],
      });
    }
    return await never();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, topUps, reads: () => reads, release: () => stalled.release?.() };
}

const SIGNED_IN = {
  'ops-astro.session': JSON.stringify({
    businessKey: 'alpha',
    email: 'mia@alpha.local',
    sessionId: 'sid-old',
  }),
};

const live: Mounted[] = [];
afterEach(async () => {
  for (const view of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await view.unmount();
  }
});

it('a top-up refused for a fresh sign-in keeps its code prompt through a stalled reread and resends once as the same attempt', async () => {
  const server = api();
  const { view } = await open('/task/TSK-41', { fetch: server.fetch, seed: SIGNED_IN });
  live.push(view);
  await settle();
  await view.type('#top-up-amount', '10');
  await view.click('[data-top-up="submit"]');
  await settle();
  expect(server.topUps.map((call) => call.session)).toStrictEqual(['sid-old']);
  expect(
    view.find(`[data-top-up="section"] ${PROMPT}`),
    'the refusal opens the prompt',
  ).not.toBeNull();

  // Another reread starts while the prompt is open, and stalls.
  const before = server.reads();
  await view.click('[data-refresh="task"]');
  await settle();
  expect(server.reads()).toBe(before + 1);
  expect(view.find(`${PROMPT}`), 'the prompt survives the reread').not.toBeNull();

  await view.type(`${PROMPT} [data-step-up="code"]`, '123456');
  await view.click(`${PROMPT} [data-step-up="confirm"]`);
  await settle();
  server.release();
  await settle();

  expect(server.topUps.map((call) => call.session)).toStrictEqual(['sid-old', 'sid-new']);
  expect(server.topUps[1]?.body).toStrictEqual(server.topUps[0]?.body);
  expect(server.topUps[0]?.body).toMatchObject({
    recordId: TASK_ID,
    amountMinor: 1_000,
    fromMaximumMinor: 250_000,
  });
  expect(view.find(`${PROMPT}`)).toBeNull();
});

it('a stepped-up top-up whose answer was lost is sent again as the same attempt on the next press', async () => {
  const server = api(true);
  const { view } = await open('/task/TSK-41', { fetch: server.fetch, seed: SIGNED_IN });
  live.push(view);
  server.release();
  await settle();
  await view.type('#top-up-amount', '10');
  await view.click('[data-top-up="submit"]');
  await settle();
  await view.type(`${PROMPT} [data-step-up="code"]`, '123456');
  await view.click(`${PROMPT} [data-step-up="confirm"]`);
  await settle();
  expect(server.topUps.map((call) => call.session)).toStrictEqual(['sid-old', 'sid-new']);
  expect(
    view.find('[data-top-up="unresolved"]'),
    'the lost answer keeps the attempt',
  ).not.toBeNull();

  await view.type('#top-up-amount', '25');
  await view.click('[data-top-up="submit"]');
  await settle();
  expect(server.topUps.map((call) => call.session)).toStrictEqual([
    'sid-old',
    'sid-new',
    'sid-new',
  ]);
  expect(server.topUps[2]?.body, 'the same id and figures').toStrictEqual(server.topUps[0]?.body);
  expect(view.find('[data-top-up="unresolved"]')).toBeNull();
});
