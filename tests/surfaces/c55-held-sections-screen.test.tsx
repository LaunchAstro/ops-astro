// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C55's three held sections on the operations view: the security alerts S0-2
// raises, the last tested restore from S0-3's drill receipt, and the link to
// the error sink. Their reads are not served yet (BUILDABLE-NOW decisions 6
// and 7), so `operations.read` may leave them out. Absent, each section draws
// made-up values under the kit's Mock label; served, it draws the read with no
// label at all.

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const SESSION = { token: 'the-live-token', businessKey: 'alpha', email: 'ada@alpha.local' };

/** The read as the API serves it today: none of the three held fields. */
const BARE = { ok: true, unattended: [], privacyIncidents: [], breachRunbook: null };

const CANARY = 'canary-secret-5b0a4c1e';

const ALERT = {
  kind: 'api_key.misuse',
  at: '2026-09-30T06:15:00.000Z',
  concerns: 'The API key named Reporting export',
  // Never drawn: an alert is shown by its time and what it concerns only.
  secret: CANARY,
  record: `record content ${CANARY}`,
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

// One view at a time: a case opens several, and unmounting them together
// overlaps `act` calls, which leaves the next case's first render unflushed.
let live: Mounted | undefined;
afterEach(async () => {
  await live?.unmount();
  live = undefined;
});

async function open(read: Record<string, unknown>): Promise<Mounted> {
  await live?.unmount();
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
  const fetch = (() => Promise.resolve(json(read))) as unknown as typeof globalThis.fetch;
  const view = await mount(
    <App
      path="/settings/operations/"
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
  live = view;
  await settle();
  await settle();
  return view;
}

/** The section, which must be drawn. */
function section(view: Mounted, name: string): Element {
  const el = view.find(`[data-section="${name}"]`);
  expect(el, `section ${name}`).not.toBeNull();
  return el as Element;
}

/** The kit's Mock label on the section's made-up region, or null. */
const mockLabel = (el: Element, name: string): string | null =>
  el.querySelector(`[data-mock="${name}"] > .is-mock > .mocktag`)?.textContent ?? null;

/** Real data never carries the label, the region or the mock mark. */
const unlabelled = (el: Element): boolean =>
  el.querySelector('.mocktag, .is-mock, [data-mock]') === null;

describe('C55 security alerts listed', () => {
  it("C55 security alerts listed (mock until S0-2's read): absent from the read, the section shows made-up alerts under the Mock label", async () => {
    const view = await open(BARE);
    const el = section(view, 'security-alerts');
    expect(mockLabel(el, 'security-alerts')).toBe('Mock');
    expect(el.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
    expect(el.textContent).toContain('Made-up');
  });

  it('C55 security alerts listed: served alerts draw unlabelled with time and what they concern', async () => {
    const view = await open({ ...BARE, securityAlerts: [ALERT] });
    const el = section(view, 'security-alerts');
    expect(unlabelled(el)).toBe(true);
    const row = el.querySelector('tbody tr');
    expect(row?.textContent).toContain(ALERT.kind);
    expect(row?.textContent).toContain(ALERT.at);
    expect(row?.textContent).toContain(ALERT.concerns);
    expect(view.text()).not.toContain(CANARY);
    expect(el.textContent).not.toContain('Made-up');
  });
});

describe('C55 last tested restore', () => {
  it("C55 last tested restore (mock until S0-3's read): absent, made-up and labelled; served and stale, it says Stale", async () => {
    const absent = section(await open(BARE), 'last-restore');
    expect(mockLabel(absent, 'last-restore')).toBe('Mock');
    expect(absent.textContent).toContain('Made-up');

    const at = '2026-09-28T02:00:00.000Z';
    const stale = section(
      await open({ ...BARE, lastTestedRestore: { at, stale: true } }),
      'last-restore',
    );
    expect(unlabelled(stale)).toBe(true);
    expect(stale.textContent).toContain(at);
    expect(stale.textContent).toContain('Stale');

    const never = section(
      await open({ ...BARE, lastTestedRestore: { at: null, stale: false } }),
      'last-restore',
    );
    expect(unlabelled(never)).toBe(true);
    expect(never.textContent).toContain('never');
    expect(never.textContent).not.toContain('Stale');
  });
});

describe('C55 error sink link', () => {
  it('C55 error sink link: served, the link goes to its url; absent, made-up and labelled', async () => {
    const url = 'https://errors.example.test/ops-astro';
    const served = section(await open({ ...BARE, errorSink: { url } }), 'error-sink');
    expect(unlabelled(served)).toBe(true);
    expect(served.querySelector('a[data-link="error-sink"]')?.getAttribute('href')).toBe(url);

    const absent = section(await open(BARE), 'error-sink');
    expect(mockLabel(absent, 'error-sink')).toBe('Mock');
    expect(absent.textContent).toContain('Made-up');
  });
});
