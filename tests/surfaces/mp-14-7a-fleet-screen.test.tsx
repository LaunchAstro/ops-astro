// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one ticket's browser cases, named after its checklist lines */
//
// MP-14-7a, the browser's half of Connections & signal: the fleet table's
// facets, sort, expansion and paging, the freshness tone, the controls that
// stay unavailable until connectors exist, and the repair button. The server
// is a stub that answers `connection.fleet` with fourteen connections and
// records every call, so the view-state cases can prove they send nothing.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { ConnectionsScreen } from '../../apps/web/src/screens/Connections.tsx';
import {
  freshnessOf,
  initialFleetView,
  FIRST_DIRECTION,
} from '../../apps/web/src/screens/connections/fleet-view.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { ConnectionView } from '../../packages/core-wire/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const hoursAgo = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- let the answers land in turn
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

function connection(
  index: number,
  status: ConnectionView['status'],
  clients: number,
  syncedHoursAgo: number | null,
): ConnectionView {
  return {
    id: `c-${String(index).padStart(2, '0')}`,
    connectorKey: 'source',
    label: `Source ${String(index).padStart(2, '0')}`,
    authMethod: 'OAuth 2.0',
    status,
    failureClass: status === 'active' ? null : 'auth_expired',
    cadenceMinutes: 1440,
    lastSyncedAt: syncedHoursAgo === null ? null : hoursAgo(syncedHoursAgo),
    lastAttemptAt: hoursAgo(1 + index),
    scope: 'r_ads',
    readComponents: ['campaigns'],
    executeComponents: status === 'broken' ? ['budgets'] : [],
    custody: { secretId: `s-${index}`, state: 'set' },
    clients: Array.from({ length: clients }, (_, n) => ({
      id: `k-${index}-${n}`,
      label: `Client ${index}.${n}`,
    })),
    repairStartedAt: null,
    revision: 1,
  };
}

// Nine active, two degraded, three broken: fourteen, as the mockup draws.
const ROWS: readonly ConnectionView[] = [
  ...Array.from({ length: 9 }, (_, n) => connection(n, 'active', n + 1, 2)),
  connection(9, 'degraded', 3, 60),
  connection(10, 'degraded', 0, 30),
  connection(11, 'broken', 12, 200),
  connection(12, 'broken', 2, null),
  connection(13, 'broken', 1, 120),
];

function server(): { readonly fetch: typeof globalThis.fetch; readonly sent: string[] } {
  const sent: string[] = [];
  const repaired = new Set<string>();
  const answer = (url: string | URL, init?: RequestInit): Response => {
    const at = String(url);
    sent.push(`${at} ${String(init?.body ?? '')}`);
    if (at.endsWith('/connection/fleet')) {
      const rows = ROWS.map((one) =>
        repaired.has(one.id) ? Object.assign({}, one, { repairStartedAt: hoursAgo(0) }) : one,
      );
      const count = (status: string): number => rows.filter((one) => one.status === status).length;
      return json({
        ok: true,
        connections: rows,
        counts: {
          all: rows.length,
          active: count('active'),
          degraded: count('degraded'),
          broken: count('broken'),
          clientConnections: rows.reduce((sum, one) => sum + one.clients.length, 0),
        },
      });
    }
    if (at.endsWith('/connector/repair')) {
      const { connectionId } = JSON.parse(String(init?.body)) as { connectionId: string };
      repaired.add(connectionId);
      return json({
        recordId: 'r-1',
        revision: 1,
        detail: { repairId: 'r-1', connectionId, state: 'awaiting approval' },
      });
    }
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
  };
  const fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(answer(url, init))) as typeof globalThis.fetch;
  return { fetch, sent };
}

async function open(): Promise<{ readonly page: Mounted; readonly sent: string[] }> {
  const stub = server();
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: stub.fetch,
  });
  const page = await mount(<ConnectionsScreen client={client} now={() => NOW} />);
  await tick();
  return { page, sent: stub.sent };
}

const shownIds = (page: Mounted): readonly string[] =>
  page.all('[data-connection]').map((row) => (row as HTMLElement).dataset['connection'] ?? '');

// eslint-disable-next-line max-lines-per-function -- one stub server, the cases that share it
describe('MP-14-7a Connections & signal fleet', () => {
  it('MP-14-7a owner check: every connector shows its status and clients, and a broken one has a Repair button', async () => {
    const { page, sent } = await open();
    await page.click('[data-fleet-more]');
    expect(shownIds(page)).toHaveLength(14);
    for (const row of ROWS) {
      const drawn = page.find(`[data-connection="${row.id}"]`);
      expect((drawn as HTMLElement | null)?.dataset['status']).toBe(row.status);
      expect(drawn?.querySelector('[data-cell="clients"]')?.textContent).toBe(
        String(row.clients.length),
      );
    }
    await page.click('[data-connection="c-11"]');
    const detail = page.find('[data-connection-detail="c-11"]');
    expect(detail?.textContent).toContain('Client 11.0');
    const repair = page.find('[data-connection-repair="c-11"]') as HTMLButtonElement | null;
    expect(repair?.disabled).toBe(false);
    expect(page.find('[data-connection-repair="c-00"]')).toBeNull();
    await page.click('[data-connection-repair="c-11"]');
    await tick();
    expect(sent.some((call) => call.includes('/connector/repair') && call.includes('c-11'))).toBe(
      true,
    );
    expect(page.find('[data-connection-detail="c-11"]')?.textContent).toContain('Repair started');
    await page.unmount();
  });

  it('MP-14-7a the banner and counts agree with the rows', async () => {
    const { page } = await open();
    const banner = page.find('[data-fleet-banner]');
    expect(banner?.textContent).toContain('3 sources are broken');
    for (const id of ['c-11', 'c-12', 'c-13']) {
      expect(banner?.textContent).toContain(ROWS.find((one) => one.id === id)?.label);
    }
    expect(page.find('[data-fleet-facet="all"]')?.textContent).toContain('14');
    expect(page.find('[data-fleet-facet="active"]')?.textContent).toContain('9');
    expect(page.find('[data-fleet-facet="degraded"]')?.textContent).toContain('2');
    expect(page.find('[data-fleet-facet="broken"]')?.textContent).toContain('3');
    await page.unmount();
  });

  it('MP-14-7a facets filter and reset the page to 10', async () => {
    const { page } = await open();
    expect(shownIds(page)).toHaveLength(10);
    await page.click('[data-fleet-more]');
    expect(shownIds(page)).toHaveLength(14);
    await page.click('[data-fleet-facet="broken"]');
    expect(shownIds(page).toSorted()).toStrictEqual(['c-11', 'c-12', 'c-13']);
    expect(page.find('[data-fleet-facet="broken"]')?.getAttribute('aria-pressed')).toBe('true');
    await page.click('[data-fleet-facet="all"]');
    expect(shownIds(page)).toHaveLength(10);
    await page.unmount();
  });

  it('MP-14-7a sort defaults and first directions as listed', async () => {
    expect(initialFleetView().sort).toStrictEqual({ key: 'clients', direction: 'desc' });
    expect(FIRST_DIRECTION).toStrictEqual({
      status: 'asc',
      source: 'asc',
      freshness: 'asc',
      clients: 'desc',
      lastPass: 'desc',
      quota: 'desc',
    });
    const { page } = await open();
    expect(shownIds(page)[0]).toBe('c-11');
    await page.click('[data-fleet-more]');
    await page.click('[data-fleet-sort="source"]');
    expect(shownIds(page)).toHaveLength(10);
    expect(shownIds(page)[0]).toBe('c-00');
    expect(page.find('[data-fleet-sort="source"]')?.closest('th')?.getAttribute('aria-sort')).toBe(
      'ascending',
    );
    await page.click('[data-fleet-sort="source"]');
    expect(shownIds(page)[0]).toBe('c-13');
    await page.click('[data-fleet-sort="lastPass"]');
    expect(shownIds(page)[0]).toBe('c-00');
    await page.unmount();
  });

  it('MP-14-7a a row click expands its detail (several may be open)', async () => {
    const { page } = await open();
    await page.click('[data-connection="c-11"]');
    await page.click('[data-connection="c-08"]');
    expect(page.find('[data-connection="c-11"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(page.find('[data-connection="c-08"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(page.all('[data-connection-detail]')).toHaveLength(2);
    const detail = page.find('[data-connection-detail="c-11"]')?.textContent ?? '';
    expect(detail).toContain('12 clients connected');
    expect(detail).toContain('r_ads');
    expect(detail).toContain('read + execute');
    expect(detail).toContain('set');
    await page.click('[data-connection="c-11"]');
    expect(page.all('[data-connection-detail]')).toHaveLength(1);
    await page.unmount();
  });

  it('MP-14-7a the freshness tone rule includes cadence', () => {
    const at = (hours: number | null, cadenceMinutes = 1440): ReturnType<typeof freshnessOf> =>
      freshnessOf({ lastSyncedAt: hours === null ? null : hoursAgo(hours), cadenceMinutes }, NOW);
    expect(at(null)).toStrictEqual({ daysBehind: null, tone: 'bad' });
    expect(at(20).tone).toBe('ok');
    expect(at(60).tone).toBe('warn');
    expect(at(96).tone).toBe('warn');
    expect(at(120).tone).toBe('bad');
    // A weekly source five days after its last pass is on its cadence, not behind.
    expect(at(120, 7 * 1440)).toStrictEqual({ daysBehind: 5, tone: 'idle' });
    expect(at(10 * 24, 7 * 1440).tone).toBe('warn');
    expect(at(30 * 24, 7 * 1440).tone).toBe('bad');
  });

  it('MP-14-7a show more adds 10 and is absent when nothing is hidden', async () => {
    const { page } = await open();
    expect(page.find('[data-fleet-showing]')?.textContent).toContain('Showing 10 of 14');
    expect(page.find('[data-fleet-more]')?.textContent).toContain('Show 4 more');
    await page.click('[data-fleet-more]');
    expect(page.find('[data-fleet-more]')).toBeNull();
    await page.unmount();
  });

  it('MP-14-7a there is no Run all syncs now', async () => {
    const { page } = await open();
    expect(page.text().toLowerCase()).not.toContain('run all syncs');
    await page.unmount();
  });

  it('MP-14-7a Sync now shows only on a stuck source, and it, re-authorise and test stay visibly unavailable', async () => {
    const { page } = await open();
    await page.click('[data-fleet-more]');
    await page.click('[data-connection="c-00"]');
    await page.click('[data-connection="c-11"]');
    expect(page.find('[data-connection-detail="c-00"] [data-action="sync"]')).toBeNull();
    for (const action of ['sync', 'reauthorise', 'test']) {
      const control = page.find(
        `[data-connection-detail="c-11"] [data-action="${action}"]`,
      ) as HTMLButtonElement | null;
      expect(control?.disabled).toBe(true);
      expect(control?.getAttribute('title')).toContain('until');
    }
    const test = page.find(
      '[data-connection-detail="c-00"] [data-action="test"]',
    ) as HTMLButtonElement | null;
    expect(test?.disabled).toBe(true);
    await page.unmount();
  });

  it('MP-14-7a the header marker is an indicator only', async () => {
    const { page } = await open();
    const marker = page.find('[data-fleet-marker]');
    expect(marker?.textContent).toContain('Last fleet pass');
    expect(marker?.tagName).not.toBe('BUTTON');
    expect(marker?.querySelector('button, a, [role="button"]')).toBeNull();
    await page.unmount();
  });

  it('MP-14-7a sections 003 to 005 show the not-connected treatment until their sources arrive', async () => {
    const { page } = await open();
    for (const section of ['credentials-quota', 'data-quality', 'band-health']) {
      expect(page.find(`[data-not-connected="${section}"]`)).not.toBeNull();
    }
    await page.unmount();
  });

  it('MP-14-7a view state adds no audit event: filter, sort, expand and show more send nothing', async () => {
    const { page, sent } = await open();
    const before = sent.length;
    await page.click('[data-fleet-facet="degraded"]');
    await page.click('[data-fleet-facet="all"]');
    await page.click('[data-fleet-sort="freshness"]');
    await page.click('[data-fleet-sort="freshness"]');
    await page.click('[data-connection="c-11"]');
    await page.click('[data-connection="c-11"]');
    await page.click('[data-fleet-more]');
    await tick();
    expect(sent.length).toBe(before);
    await page.unmount();
  });
});
