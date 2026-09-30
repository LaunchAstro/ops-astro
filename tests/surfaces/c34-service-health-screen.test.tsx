// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C34's service-health section, drawn on Settings ▸ Telemetry (CS-2.16) from
// `operations.read`, C55's one read: never a second read. The stand-in API
// answers the section's own shape (`tests/operations/c34-service-health.test.ts`
// pins it on the real API). Four service states are kept apart and each is said
// in words; a source that could not be read is named by its kind of fault and
// says nothing about its services; an optional source switched off is "off".

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const SESSION = { token: 'the-live-token', businessKey: 'alpha', email: 'ada@alpha.local' };

const SECTION = {
  checkedAt: '2026-09-30T08:00:00.000Z',
  sources: [
    { source: 'watcher', state: 'read', fault: null },
    { source: 'error-sink', state: 'read-failure', fault: 'malformed' },
    { source: 'tracing', state: 'off', fault: null },
  ],
  services: [
    {
      source: 'watcher',
      name: 'api',
      state: 'healthy',
      lastObservedAt: '2026-09-30T07:59:00.000Z',
    },
    {
      source: 'watcher',
      name: 'worker-1',
      state: 'service-failure',
      lastObservedAt: '2026-09-30T07:58:00.000Z',
    },
    {
      source: 'watcher',
      name: 'worker-2',
      state: 'stale',
      lastObservedAt: '2026-09-30T06:00:00.000Z',
    },
    { source: 'watcher', name: 'mailer', state: 'never-observed', lastObservedAt: null },
  ],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function server(answer: () => Response) {
  const urls: string[] = [];
  const fetch = ((url: string | URL) => {
    // The frame's person menu (C23) asks who is signed in; not this screen's call.
    if (String(url).endsWith('/session/person'))
      return Promise.resolve(json({ ok: true, person: {} }));
    // The dock bell's owed count (MP-7-3) and its board topic are the frame's too.
    if (String(url).endsWith('/inbox/count')) return Promise.resolve(json({ ok: true, owed: 0 }));
    if (String(url).includes('/live?')) return Promise.resolve(new Response(null, { status: 503 }));
    urls.push(String(url));
    return Promise.resolve(answer());
  }) as unknown as typeof globalThis.fetch;
  return { fetch, urls };
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
      path="/settings/telemetry/"
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

const stateOf = (view: Mounted, name: string): string | null =>
  view.find(`[data-service="${name}"]`)?.closest('tr')?.querySelector<HTMLElement>('[data-state]')
    ?.dataset['state'] ?? null;

describe('C34 service health on Settings ▸ Telemetry', () => {
  it('C34 service health: never observed, stale, service failure and healthy kept distinct, in words', async () => {
    const api = server(() =>
      json({ ok: true, privacyIncidents: [], breachRunbook: null, serviceHealth: SECTION }),
    );
    const view = await open(api.fetch);
    expect(view.find('[data-screen="telemetry"]')).not.toBeNull();
    expect(stateOf(view, 'api')).toBe('healthy');
    expect(stateOf(view, 'worker-1')).toBe('service-failure');
    expect(stateOf(view, 'worker-2')).toBe('stale');
    expect(stateOf(view, 'mailer')).toBe('never-observed');
    const words = view.find('[data-health="services"]')?.textContent ?? '';
    for (const word of ['Healthy', 'Service failure', 'Stale', 'Never observed'])
      expect(words).toContain(word);
    // C55's one read, of its own business, and nothing else.
    expect(api.urls).toEqual(['/api/b/alpha/operations/read']);
  });

  it('C34 sources: a read failure names its kind, and tracing switched off shows off, never a failure', async () => {
    const api = server(() =>
      json({ ok: true, privacyIncidents: [], breachRunbook: null, serviceHealth: SECTION }),
    );
    const view = await open(api.fetch);
    const sink = view.find('[data-source="error-sink"]')?.closest('tr')?.textContent ?? '';
    expect(sink).toContain('Could not be read');
    expect(sink).toContain('malformed');
    const tracing = view.find('[data-source="tracing"]')?.closest('tr')?.textContent ?? '';
    expect(tracing).toContain('Off');
    expect(tracing).not.toContain('Could not be read');
    expect(tracing).not.toContain('failure');
  });

  it('C34 no section: an answer without service health says so and invents no healthy service', async () => {
    const api = server(() => json({ ok: true, privacyIncidents: [], breachRunbook: null }));
    const view = await open(api.fetch);
    expect(view.find('[data-health="absent"]')).not.toBeNull();
    expect(view.find('[data-health="services"]')).toBeNull();
    expect(view.text()).not.toContain('Healthy');
  });

  it('C34 denied: a refused read is drawn denied, never as an empty section', async () => {
    const api = server(() =>
      json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403),
    );
    const view = await open(api.fetch);
    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(view.text()).toContain('SCOPE_NOT_GRANTED');
    expect(view.find('[data-health="services"]')).toBeNull();
  });
});
