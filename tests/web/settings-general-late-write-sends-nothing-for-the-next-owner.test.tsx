// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings General with a write in flight when the tab moves to another
// business or person, or signs out and back in: once the write lands, nothing
// more is sent under anyone, nothing is kept for either owner, and the next
// owner's own save carries its own operation id. A step-up keeps the owner, so
// a retry after a lost answer there replays the first attempt's id.

import { act } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SettingsGeneralScreen } from '../../apps/web/src/screens/SettingsGeneral.tsx';
import {
  SessionStore,
  grantKeyOf,
  settingsCacheKey,
  type Session,
} from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let round = 0; round < 4; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- let each answer land
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

interface Sent {
  readonly at: string;
  readonly body: Record<string, unknown>;
}

/** One business's API: every call logged, and each write held until released or lost. */
function business(key: string) {
  const sent: Sent[] = [];
  const held: (() => void)[] = [];
  let lose = false;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    sent.push({ at, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    if (at.endsWith('/session/capabilities')) {
      return Promise.resolve(
        json({
          ok: true,
          personId: 'p-ada',
          businessKey: key,
          grants: [
            { collection: 'settings', action: 'manage' },
            { collection: 'spend', action: 'decide' },
          ],
        }),
      );
    }
    if (at.endsWith('/settings/read')) return Promise.resolve(json({ ok: true, settings: [] }));
    if (at.endsWith('/agent/mine')) return Promise.resolve(json({ ok: true, agents: [] }));
    if (lose) return Promise.reject(new TypeError('Failed to fetch'));
    return new Promise<Response>((resolve) => {
      held.push(() => {
        resolve(
          at.endsWith('/agent/create')
            ? json({ ok: true, recordId: null, detail: { agentId: 'a-new' } })
            : json({ recordId: 'row', revision: 1, detail: { value: 900 } }),
        );
      });
    });
  }) as typeof globalThis.fetch;
  return {
    sent,
    land: (): void => {
      for (const release of held.splice(0)) release();
    },
    loseWrites: (): void => {
      lose = true;
    },
    client: () => new OperationsClient({ origin: '', businessKey: key, signedIn: true, fetch }),
  };
}

type World = ReturnType<typeof business>;

const ALPHA: Session = { businessKey: 'alpha', email: 'ada@example.test' };

let sessions: SessionStore;
let mounted: Mounted | undefined;
beforeEach(() => {
  window.sessionStorage.clear();
  sessions = new SessionStore(window.sessionStorage);
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const screen = (client: OperationsClient) => (
  <SettingsGeneralScreen
    client={client}
    grantKey={grantKeyOf(sessions.session)}
    storage={window.sessionStorage}
  />
);

/** Each move away from Ada in Alpha: the business the tab lands in, and the move itself. */
const moves: readonly (readonly [string, string, () => void])[] = [
  ['another business', 'bravo', () => sessions.set({ ...ALPHA, businessKey: 'bravo' })],
  ['another person', 'alpha', () => sessions.set({ ...ALPHA, email: 'bo@example.test' })],
  [
    'a sign-out and in',
    'alpha',
    () => {
      sessions.clear();
      sessions.set(ALPHA);
    },
  ],
];

const writesOf = (world: World): Sent[] =>
  world.sent.filter((call) => call.at.endsWith('/agent/create') || call.at.includes('/set_'));

it.each(moves)(
  'a threshold save in flight across %s sends nothing more and keeps nothing once it lands',
  async (_move, lands, move) => {
    const alpha = business('alpha');
    const next = business(lands);
    sessions.set(ALPHA);
    mounted = await mount(screen(alpha.client()));
    await tick();
    await mounted.type('#settings-four-eyes', '900');
    await mounted.click('[data-settings="save-four-eyes"]');
    expect(writesOf(alpha)).toHaveLength(1);
    move();
    await mounted.render(screen(next.client()));
    await tick();
    const before = [alpha.sent.length, next.sent.length];
    alpha.land();
    await tick();
    expect([alpha.sent.length, next.sent.length]).toEqual(before);
    expect(window.sessionStorage.getItem(settingsCacheKey('alpha'))).toBeNull();
    expect(mounted.find('[data-settings="save-four-eyes"]')?.textContent).not.toContain('Saving');
  },
);

it.each(moves)(
  'an agent make in flight across %s sends nothing more once it lands',
  async (_move, lands, move) => {
    const alpha = business('alpha');
    const next = business(lands);
    sessions.set(ALPHA);
    mounted = await mount(screen(alpha.client()));
    await tick();
    await mounted.type('#agent-new-name', 'Planner');
    await mounted.click('[data-agent-new] button[type="submit"]');
    expect(writesOf(alpha)).toHaveLength(1);
    move();
    await mounted.render(screen(next.client()));
    await tick();
    const before = [alpha.sent.length, next.sent.length];
    alpha.land();
    await tick();
    expect([alpha.sent.length, next.sent.length]).toEqual(before);
    expect(mounted.find('[data-agents-outcome]')).toBeNull();
  },
);

it.each(moves)(
  'a make whose answer was lost is a new operation id for the owner after %s',
  async (_move, lands, move) => {
    const alpha = business('alpha');
    const next = business(lands);
    alpha.loseWrites();
    sessions.set(ALPHA);
    mounted = await mount(screen(alpha.client()));
    await tick();
    await mounted.type('#agent-new-name', 'Planner');
    await mounted.click('[data-agent-new] button[type="submit"]');
    await tick();
    move();
    await mounted.render(screen(next.client()));
    await tick();
    await mounted.type('#agent-new-name', 'Planner');
    await mounted.click('[data-agent-new] button[type="submit"]');
    const [lost] = writesOf(alpha);
    const [fresh] = writesOf(next);
    expect(fresh?.body['operationId']).toBeDefined();
    expect(fresh?.body['operationId']).not.toBe(lost?.body['operationId']);
  },
);

it('a make retried after a lost answer and a step-up replays the first operation id on the new client', async () => {
  const before = business('alpha');
  before.loseWrites();
  sessions.set(ALPHA);
  mounted = await mount(screen(before.client()));
  await tick();
  await mounted.type('#agent-new-name', 'Planner');
  await mounted.click('[data-agent-new] button[type="submit"]');
  await tick();
  // The step-up moves the tab to a new sign-in: the same business, person and grant key.
  sessions.set(ALPHA);
  const after = business('alpha');
  await mounted.render(screen(after.client()));
  await tick();
  await mounted.type('#agent-new-name', 'Planner');
  await mounted.click('[data-agent-new] button[type="submit"]');
  const [lost] = writesOf(before);
  const [retry] = writesOf(after);
  expect(retry?.body['operationId']).toBe(lost?.body['operationId']);
});
