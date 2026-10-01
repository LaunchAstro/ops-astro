// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C55's operations view, drawn on Settings ▸ Operations from `operations.read`
// alone (CS-14.31): INB-1's unattended items, the privacy incidents with the
// breach runbook they link, and C34's service-health section, the same one
// Settings ▸ Telemetry draws and links back to. The stand-in API answers the
// read's own shape; `tests/operations/c55-operations-view.test.ts` and
// `tests/commands/inbox-unattended.test.ts` pin it on the real API.

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const SESSION = { token: 'the-live-token', businessKey: 'alpha', email: 'ada@alpha.local' };

const UNATTENDED = {
  id: '5b0a4c1e-0000-4000-8000-000000000001',
  recipientPersonId: '5b0a4c1e-0000-4000-8000-00000000000a',
  subjectRecordId: '5b0a4c1e-0000-4000-8000-00000000000b',
  reason: 'decision',
  factKind: 'gate',
  factId: '5b0a4c1e-0000-4000-8000-00000000000c',
  raisedAt: '2026-09-30T08:00:00.000Z',
};

const INCIDENT = {
  id: '5b0a4c1e-0000-4000-8000-000000000002',
  whatHappened: 'A made-up export went to the wrong inbox',
  foundAt: '2026-08-20T09:00:00.000Z',
  foundBy: 'Ada',
  affected: 'Two made-up contacts',
  informationKinds: ['contact'],
  assessBy: '2026-09-19T09:00:00.000Z',
  overdue: true,
  status: 'open',
  recordedAt: '2026-08-20T09:05:00.000Z',
  recordedByActorId: '5b0a4c1e-0000-4000-8000-00000000000d',
};

const RUNBOOK = {
  version: '1.0',
  digest: 'sha256:made-up',
  publishedAt: '2026-09-28T00:00:00.000Z',
  body: '# Breach runbook',
};

const HEALTH = {
  checkedAt: '2026-09-30T08:00:00.000Z',
  sources: [{ source: 'watcher', state: 'read', fault: null }],
  services: [
    {
      source: 'watcher',
      name: 'api',
      state: 'healthy',
      lastObservedAt: '2026-09-30T07:59:00.000Z',
    },
  ],
};

const READ = {
  ok: true,
  unattended: [UNATTENDED],
  privacyIncidents: [INCIDENT],
  breachRunbook: RUNBOOK,
  serviceHealth: HEALTH,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function server(answer: () => Response) {
  const urls: string[] = [];
  const fetch = ((url: string | URL) => {
    urls.push(String(url));
    return Promise.resolve(answer());
  }) as unknown as typeof globalThis.fetch;
  return { fetch, urls };
}

const live: Mounted[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((view) => view.unmount()));
});

async function open(
  fetch: typeof globalThis.fetch,
  path = '/settings/operations/',
): Promise<Mounted> {
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
      path={path}
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

describe('C55 the operations view page', () => {
  it('C55 operations view contents: unattended items, privacy incidents with the runbook, and service health, from one read', async () => {
    const api = server(() => json(READ));
    const view = await open(api.fetch);
    expect(view.find('[data-screen="operations"]')).not.toBeNull();

    const unattended = view.find(`[data-unattended="${UNATTENDED.id}"]`)?.closest('tr');
    expect(unattended?.textContent).toContain('Decision');
    expect(unattended?.textContent).toContain(UNATTENDED.raisedAt);

    const incident = view.find(`[data-incident="${INCIDENT.id}"]`)?.closest('tr');
    expect(incident?.textContent).toContain(INCIDENT.whatHappened);
    expect(incident?.textContent).toContain('Overdue');
    expect(view.find('[data-runbook]')?.textContent).toContain('1.0');

    expect(view.find('[data-health="services"]')?.textContent).toContain('Healthy');
    // C55's one read, of its own business, and nothing else.
    expect(api.urls).toEqual(['/api/b/alpha/operations/read']);
  });

  it('C55 operations view contents: nothing unattended and no incident are said in words, and no runbook says so', async () => {
    const api = server(() =>
      json({ ...READ, unattended: [], privacyIncidents: [], breachRunbook: null }),
    );
    const view = await open(api.fetch);
    expect(view.find('[data-section="unattended"]')?.textContent).toContain(
      'Nothing is unattended',
    );
    expect(view.find('[data-section="incidents"]')?.textContent).toContain('No privacy incident');
    expect(view.find('[data-runbook]')?.textContent).toContain('No breach runbook is published');
  });
});

describe('C55 the operations view page', () => {
  it('C55 refusal operations:read: a refused read is drawn denied, with no section of the view', async () => {
    const api = server(() =>
      json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403),
    );
    const view = await open(api.fetch);
    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(view.text()).toContain('SCOPE_NOT_GRANTED');
    for (const section of ['unattended', 'incidents'])
      expect(view.find(`[data-section="${section}"]`)).toBeNull();
    expect(view.find('[data-health="services"]')).toBeNull();
  });

  it('C55 one watcher read: Settings ▸ Telemetry draws the same section from the same read and links to the view', async () => {
    const api = server(() => json(READ));
    const view = await open(api.fetch, '/settings/telemetry/');
    expect(api.urls).toEqual(['/api/b/alpha/operations/read']);
    const link = view.find('[data-link="operations"]');
    expect(link?.getAttribute('href')).toBe('/settings/operations/');
  });
});
