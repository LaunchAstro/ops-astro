// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C58: a person sees and can end their other sessions, on Settings ▸ General
// (TR-SEC-3). The panel lists what `account/sessions/list` answers, this
// session marked, and "Sign out other sessions" sends one confirmed
// `account/sessions/end-others`, then lists again. Both are the person's own
// account routes with an empty body: the server takes the person and this
// session from the credential, so nothing in a body can name another person,
// another session or an agent. The stand-in API answers the shapes
// `tests/api/c58-sessions.test.ts` pins on the real one.

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

/** The tab's credential: a canary that must never be drawn. */
const SESSION = {
  token: 'c58-bearer-canary-token',
  businessKey: 'alpha',
  email: 'ada@alpha.local',
};

const THIS = {
  sessionId: '5c580000-0000-4000-8000-000000000001',
  current: true,
  firstSeenAt: '2026-10-01T01:00:00.000Z',
  lastSeenAt: '2026-10-01T03:30:00.000Z',
};
const LAPTOP = {
  sessionId: '5c580000-0000-4000-8000-000000000002',
  current: false,
  firstSeenAt: '2026-09-30T22:00:00.000Z',
  lastSeenAt: '2026-10-01T02:15:00.000Z',
};
const PHONE = {
  sessionId: '5c580000-0000-4000-8000-000000000003',
  current: false,
  firstSeenAt: '2026-09-30T23:40:00.000Z',
  lastSeenAt: '2026-10-01T00:05:00.000Z',
};

const LIST = '/api/b/alpha/account/sessions/list';
const END_OTHERS = '/api/b/alpha/account/sessions/end-others';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  readonly url: string;
  readonly body: unknown;
}

/**
 * A stand-in API. `lists` answers the sessions list in turn (the last one
 * repeats), `endOthers` answers the end; the settings page's own two reads
 * answer as a person who may manage settings.
 */
function server(lists: readonly unknown[], ending: () => Response) {
  const calls: Call[] = [];
  let listed = 0;
  const answer = (at: string): Response => {
    if (at === LIST) {
      const body = lists[Math.min(listed, lists.length - 1)];
      listed += 1;
      return json(body);
    }
    if (at === END_OTHERS) return ending();
    if (at.endsWith('/session/capabilities')) {
      return json({ ok: true, personId: 'p-ada', businessKey: 'alpha', grants: [] });
    }
    return json({ ok: true, settings: [] });
  };
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    calls.push({ url: at, body: JSON.parse(String(init?.body ?? 'null')) as unknown });
    return Promise.resolve(answer(at));
  }) as unknown as typeof globalThis.fetch;
  const account = (): Call[] => calls.filter((call) => call.url.includes('/account/'));
  return { fetch, calls, account };
}

const live: Mounted[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((view) => view.unmount()));
});

async function open(fetch: typeof globalThis.fetch): Promise<Mounted> {
  const held = new Map([['ops-astro.session', JSON.stringify(SESSION)]]);
  const sessions = new SessionStore({
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  });
  const view = await mount(
    <App
      path="/settings"
      navigate={() => {
        // One address for the whole case.
      }}
      sessions={sessions}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      storage={window.sessionStorage}
    />,
  );
  live.push(view);
  await settle();
  await settle();
  return view;
}

const rows = (view: Mounted): string[] =>
  view.all('[data-sessions="list"] tbody tr').map((row) => row.textContent ?? '');

/** Press "Sign out other sessions", then confirm it. */
async function endOthers(view: Mounted, api: ReturnType<typeof server>): Promise<void> {
  await view.click('[data-sessions="end-others"] button');
  // Nothing is sent before the act is confirmed.
  expect(api.account().filter((call) => call.url === END_OTHERS)).toEqual([]);
  await view.click('[data-confirm="end-others"] [data-act="end"] button');
  await settle();
  await settle();
}

/** The canary: no bearer, token or raw session id is drawn anywhere. */
function expectNoSecretDrawn(view: Mounted): void {
  const drawn = view.host.innerHTML;
  for (const secret of [SESSION.token, 'Bearer', THIS.sessionId, LAPTOP.sessionId, PHONE.sessionId])
    expect(drawn.includes(secret), 'a secret or raw id is drawn').toBe(false);
}

describe('C58 end other sessions from Settings', () => {
  it('C58 end other sessions from Settings: the list shows this session and the others, and ending the others sends one end-others and lists again', async () => {
    const ended = { ended: 2, signedOutAtProvider: true };
    const api = server([{ sessions: [THIS, LAPTOP, PHONE] }, { sessions: [THIS] }], () =>
      json(ended),
    );
    const view = await open(api.fetch);
    const before = rows(view);
    expect(before).toHaveLength(3);
    expect(before[0]).toContain('This session');
    expect(before[0]).toContain(THIS.firstSeenAt);
    expect(before[0]).toContain(THIS.lastSeenAt);
    expect(before[1]).toContain(LAPTOP.lastSeenAt);
    expect(before[1]).not.toContain('This session');
    expectNoSecretDrawn(view);

    await endOthers(view, api);
    expect(api.account()).toEqual([
      { url: LIST, body: {} },
      { url: END_OTHERS, body: {} },
      { url: LIST, body: {} },
    ]);
    const after = rows(view);
    expect(after).toHaveLength(1);
    expect(after[0]).toContain('This session');
    expect(view.find('[data-sessions-outcome]')?.textContent).toContain('2');
    expectNoSecretDrawn(view);
  });
});

describe('C58 end other sessions refused', () => {
  it('C58 end other sessions: a refusal is shown by its code and the list stays', async () => {
    const refused = {
      refused: true,
      code: 'AUTH_SECOND_FACTOR_REQUIRED',
      names: [],
      fixes: ['Give your second-factor code, then try again.'],
    };
    const api = server([{ sessions: [THIS, LAPTOP] }], () => json(refused, 403));
    const view = await open(api.fetch);
    await endOthers(view, api);
    expect(view.find('[data-sessions-outcome]')?.textContent).toContain(
      'AUTH_SECOND_FACTOR_REQUIRED',
    );
    // The list is not read again and still shows both sessions.
    expect(api.account()).toEqual([
      { url: LIST, body: {} },
      { url: END_OTHERS, body: {} },
    ]);
    expect(rows(view)).toHaveLength(2);
    expectNoSecretDrawn(view);
  });
});

describe('C58 own sessions only', () => {
  it("C58 own sessions only: the page asks only the person's own account routes, never another person's or an agent's", async () => {
    const api = server([{ sessions: [THIS, LAPTOP] }, { sessions: [THIS] }], () =>
      json({ ended: 1, signedOutAtProvider: true }),
    );
    const view = await open(api.fetch);
    await endOthers(view, api);
    // Only the person prefix of this business, only the two sessions routes.
    const paths = new Set(api.account().map((call) => call.url));
    expect([...paths].toSorted()).toEqual([END_OTHERS, LIST]);
    for (const call of api.calls) {
      expect(call.url.startsWith('/api/b/alpha/'), call.url).toBe(true);
      expect(call.url.includes('/api/a/'), call.url).toBe(false);
    }
    // Every account body is empty: no person, actor, agent or session is named in one.
    for (const call of api.account()) expect(call.body).toEqual({});
    const sent = JSON.stringify(api.calls.map((call) => call.body));
    for (const named of [LAPTOP.sessionId, THIS.sessionId, 'p-ada', SESSION.token])
      expect(sent.includes(named)).toBe(false);
  });
});
