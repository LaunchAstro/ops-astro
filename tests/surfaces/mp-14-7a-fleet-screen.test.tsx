// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* eslint-disable max-lines -- one ticket's browser cases, named after its checklist lines */
//
// MP-14-7a, the browser's half of Connections & signal: the fleet table's
// facets, sort, expansion and paging, the freshness tone, the controls that
// stay unavailable until connectors exist, and the repair button. The server
// is a stub that answers `connection.fleet` per business and records every
// call, so the view-state cases can prove they send nothing.

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsScreen } from '../../apps/web/src/screens/Connections.tsx';
import {
  freshnessOf,
  initialFleetView,
  isStuck,
  FIRST_DIRECTION,
} from '../../apps/web/src/screens/connections/fleet-view.ts';
import { FLOOR_MS } from '../../apps/web/src/data/live.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SCREENS, type ScreenContext } from '../../apps/web/src/screen-registry.tsx';
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
  prefix = 'c',
): ConnectionView {
  const id = `${prefix}-${String(index).padStart(2, '0')}`;
  return {
    id,
    connectorKey: 'source',
    label: `${prefix === 'c' ? 'Source' : 'Bravo source'} ${String(index).padStart(2, '0')}`,
    authMethod: 'OAuth 2.0',
    status,
    failureClass: status === 'active' ? null : 'auth_expired',
    cadenceMinutes: 1440,
    lastSyncedAt: syncedHoursAgo === null ? null : hoursAgo(syncedHoursAgo),
    lastAttemptAt: hoursAgo(1 + index),
    scope: 'r_ads',
    readComponents: ['campaigns'],
    executeComponents: status === 'broken' ? ['budgets'] : [],
    custody: { secretId: `s-${id}`, state: 'set' },
    clients: Array.from({ length: clients }, (_, n) => ({
      id: `k-${id}-${n}`,
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

// A second business's own fleet: other ids, other clients, a broken row of its own.
const BRAVO_ROWS: readonly ConnectionView[] = [
  connection(1, 'active', 2, 2, 'b'),
  connection(2, 'broken', 1, 200, 'b'),
];

// Twenty-five sources, so Show more can add a full 10 and then the last 5.
const WIDE_ROWS: readonly ConnectionView[] = Array.from({ length: 25 }, (_, n) =>
  connection(n, 'active', 1, 2, 'w'),
);

type Fleets = Readonly<Record<string, readonly ConnectionView[]>>;

const FLEETS: Fleets = {
  alpha: ROWS,
  bravo: BRAVO_ROWS,
  charlie: WIDE_ROWS,
};

// Two people in business alpha, each reading connections at their own client.
const labelled = (row: ConnectionView, client: string): ConnectionView => ({
  ...row,
  clients: [{ id: `k-${client}`, label: client }],
});
const ADA_FLEET: Fleets = {
  alpha: [labelled(connection(1, 'broken', 1, 200), 'Ada canary client')],
};
const BEA_FLEET: Fleets = {
  alpha: [labelled(connection(2, 'broken', 1, 200), 'Bea canary client')],
};

/** A promise held open until its `release` is called. */
const gate = (): { readonly wait: Promise<void>; readonly release: () => void } => {
  const opener: { open?: () => void } = {};
  const wait = new Promise<void>((resolve) => {
    opener.open = resolve;
  });
  return {
    wait,
    release: () => {
      opener.open?.();
    },
  };
};

interface Stub {
  readonly fetch: typeof globalThis.fetch;
  readonly sent: string[];
  /** The `operationId` of every `connector.repair` sent, in order. */
  readonly repairIds: string[];
  /** Hold the next fleet read of `business` until `release` is called. */
  readonly holdFleet: (business: string) => () => void;
  /** Answer the next repair with this instead of starting it. */
  readonly nextRepair: (answer: 'lost' | 'stale') => void;
  /** Hold the next repair's answer until `release` is called. */
  readonly holdRepair: () => () => void;
  /** Refuse every fleet read from now on, as a revoked `connection:read` would. */
  readonly refuseFleet: () => void;
  /** Answer every fleet read from now on `ms` after it is asked. */
  readonly delayFleet: (ms: number) => void;
}

function fleetOf(rows: readonly ConnectionView[], repaired: ReadonlySet<string>): unknown {
  const shown = rows.map((one) =>
    repaired.has(one.id) ? { ...one, repairStartedAt: hoursAgo(0), revision: 2 } : one,
  );
  const count = (status: string): number => shown.filter((one) => one.status === status).length;
  return {
    ok: true,
    connections: shown,
    counts: {
      all: shown.length,
      active: count('active'),
      degraded: count('degraded'),
      broken: count('broken'),
      clientConnections: shown.reduce((sum, one) => sum + one.clients.length, 0),
    },
  };
}

// eslint-disable-next-line max-lines-per-function -- one stub server, the routes it answers
function server(fleets: Fleets = FLEETS): Stub {
  const sent: string[] = [];
  const repairIds: string[] = [];
  const repaired = new Set<string>();
  const held = new Map<string, Promise<void>>();
  let repairHeld: Promise<void> | undefined;
  const queued: ('lost' | 'stale')[] = [];
  let refusing = false;
  let fleetDelay = 0;
  const answer = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const at = String(url);
    sent.push(`${at} ${String(init?.body ?? '')}`);
    const business = /\/(alpha|bravo|charlie)\//u.exec(at)?.[1] ?? '';
    if (at.endsWith('/connection/fleet')) {
      const wait = held.get(business);
      held.delete(business);
      await wait;
      if (fleetDelay > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, fleetDelay);
        });
      }
      if (refusing)
        return json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403);
      return json(fleetOf(fleets[business] ?? [], repaired));
    }
    if (at.endsWith('/connector/repair')) {
      const body = JSON.parse(String(init?.body)) as { connectionId: string; operationId: string };
      repairIds.push(body.operationId);
      const wait = repairHeld;
      repairHeld = undefined;
      await wait;
      const next = queued.shift();
      if (next === 'lost') throw new TypeError('network down');
      if (next === 'stale') {
        return json(
          { refused: true, code: 'VERSION_STALE', names: [], fixes: ['Read it again.'] },
          409,
        );
      }
      repaired.add(body.connectionId);
      return json({
        ok: true,
        recordId: 'r-1',
        revision: 1,
        detail: { repairId: 'r-1', connectionId: body.connectionId, state: 'awaiting approval' },
      });
    }
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
  };
  return {
    fetch: ((url: string | URL, init?: RequestInit) => answer(url, init)) as typeof fetch,
    sent,
    repairIds,
    holdFleet: (business) => {
      const { wait, release } = gate();
      held.set(business, wait);
      return release;
    },
    holdRepair: () => {
      const { wait, release } = gate();
      repairHeld = wait;
      return release;
    },
    nextRepair: (outcome) => {
      queued.push(outcome);
    },
    refuseFleet: () => {
      refusing = true;
    },
    delayFleet: (ms) => {
      fleetDelay = ms;
    },
  };
}

function clientFor(stub: Stub, business: string): OperationsClient {
  return new OperationsClient({
    origin: '',
    businessKey: business,
    signedIn: true,
    fetch: stub.fetch,
  });
}

async function open(): Promise<{ readonly page: Mounted; readonly stub: Stub }> {
  const stub = server();
  const page = await mount(
    <ConnectionsScreen client={clientFor(stub, 'alpha')} grantKey="alpha:a@x:0" now={() => NOW} />,
  );
  await tick();
  return { page, stub };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Advance fake time by `ms`, letting the reads it starts land. */
async function pass(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Another person starts a repair through the same stub server. */
async function someoneElseRepairs(stub: Stub, id: string): Promise<void> {
  await stub.fetch('/api/b/alpha/connector/repair', {
    method: 'POST',
    body: JSON.stringify({ connectionId: id, operationId: `other-${id}` }),
  });
}

function alphaContext(stub: Stub): ScreenContext<'agency:connections'> {
  return {
    client: clientFor(stub, 'alpha'),
    grantKey: 'alpha:a@x:0',
    params: {},
    notice: null,
    storage: null,
    navigate: () => {},
  };
}

const shownIds = (page: Mounted): readonly string[] =>
  page.all('[data-connection]').map((row) => (row as HTMLElement).dataset['connection'] ?? '');

// eslint-disable-next-line max-lines-per-function -- one stub server, the cases that share it
describe('MP-14-7a Connections & signal fleet', () => {
  it('MP-14-7a owner check: every connector shows its status and clients, and a broken one has a Repair button', async () => {
    const { page, stub } = await open();
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
    await page.click('[data-connection="c-00"]');
    expect(page.find('[data-connection-detail="c-00"]')).not.toBeNull();
    expect(page.find('[data-connection-repair="c-00"]')).toBeNull();
    // Custody shows the credential's state, never its secret's id.
    for (const row of ROWS) {
      if (!row.id.endsWith('-11') && !row.id.endsWith('-00')) {
        await page.click(`[data-connection="${row.id}"]`); // eslint-disable-line no-await-in-loop -- one row at a time
      }
    }
    expect(page.all('[data-connection-detail]')).toHaveLength(14);
    expect(page.host.outerHTML).not.toContain('s-c-');
    await page.click('[data-connection-repair="c-11"]');
    await tick();
    expect(
      stub.sent.some((call) => call.includes('/connector/repair') && call.includes('c-11')),
    ).toBe(true);
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
    const tiles = page.all('[data-fleet-tiles] .stat').map((tile) => tile.textContent);
    expect(tiles).toStrictEqual(['Sources clean9 of 14', 'Degraded2 of 14', 'Broken3 of 14']);
    expect(page.find('[data-section="001"]')?.textContent).toContain(
      '14 sources · 63 client connections',
    );
    await page.unmount();
  });

  it('MP-14-7a Fix now opens the broken facet with each broken source open at its Repair button', async () => {
    const { page } = await open();
    // A broken source already open stays open.
    await page.click('[data-fleet-more]');
    await page.click('[data-connection="c-11"]');
    await page.click('[data-fleet-fix]');
    expect(shownIds(page).toSorted()).toStrictEqual(['c-11', 'c-12', 'c-13']);
    for (const id of ['c-11', 'c-12', 'c-13']) {
      expect(page.find(`[data-connection-repair="${id}"]`)).not.toBeNull();
    }
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
    expect(page.find('[data-connection-toggle="c-11"]')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(page.find('[data-connection-toggle="c-08"]')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    // The state is announced once, on the button, not again on the row.
    expect(page.find('[data-connection="c-11"]')?.hasAttribute('aria-expanded')).toBe(false);
    expect(page.all('[data-connection-detail]')).toHaveLength(2);
    const detail = page.find('[data-connection-detail="c-11"]')?.textContent ?? '';
    expect(detail).toContain('12 clients connected');
    expect(detail).toContain('r_ads');
    expect(detail).toContain('read + execute');
    expect(detail).toContain('set');
    await page.click('[data-connection="c-11"]');
    expect(page.all('[data-connection-detail]')).toHaveLength(1);
    // The row's disclosure is a button a keyboard can reach, and it opens the row once.
    const toggle = page.find('[data-connection-toggle="c-07"]') as HTMLButtonElement | null;
    expect(toggle?.tagName).toBe('BUTTON');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await page.click('[data-connection-toggle="c-07"]');
    expect(page.find('[data-connection-detail="c-07"]')).not.toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(page.all('[data-connection-detail]')).toHaveLength(2);
    await page.unmount();
  });

  it('MP-14-7a the freshness tone rule includes cadence', () => {
    const at = (hours: number | null, cadenceMinutes = 1440): ReturnType<typeof freshnessOf> =>
      freshnessOf({ lastSyncedAt: hours === null ? null : hoursAgo(hours), cadenceMinutes }, NOW);
    expect(at(null)).toStrictEqual({ daysBehind: null, tone: 'bad' });
    // AG-C15: ok up to T-1, warn up to T-4, bad beyond, counted in whole cadences behind.
    expect(at(20).tone).toBe('ok');
    expect(at(30)).toStrictEqual({ daysBehind: 1, tone: 'ok' });
    expect(at(47).tone).toBe('ok');
    expect(at(48)).toStrictEqual({ daysBehind: 2, tone: 'warn' });
    expect(at(100)).toStrictEqual({ daysBehind: 4, tone: 'warn' });
    expect(at(119).tone).toBe('warn');
    expect(at(120)).toStrictEqual({ daysBehind: 5, tone: 'bad' });
    // A weekly source five days after its last pass is on its cadence, not behind.
    expect(at(120, 7 * 1440)).toStrictEqual({ daysBehind: 5, tone: 'idle' });
    expect(at(10 * 24, 7 * 1440).tone).toBe('idle');
    expect(at(14 * 24, 7 * 1440).tone).toBe('warn');
    expect(at(34 * 24, 7 * 1440).tone).toBe('warn');
    expect(at(35 * 24, 7 * 1440).tone).toBe('bad');
  });

  it('MP-14-7a a source is stuck when it is behind its cadence, failed or never synced', () => {
    const row = (status: ConnectionView['status'], hours: number | null): ConnectionView => ({
      ...connection(1, status, 1, hours),
      failureClass: null,
    });
    expect(isStuck(row('active', 20), NOW)).toBe(false);
    expect(isStuck(row('active', 47), NOW)).toBe(false);
    expect(isStuck(row('active', 48), NOW)).toBe(true);
    expect(isStuck(row('active', null), NOW)).toBe(true);
    expect(isStuck(row('degraded', 2), NOW)).toBe(true);
    expect(isStuck(row('broken', 2), NOW)).toBe(true);
    // A weekly source inside its cadence is not behind.
    expect(isStuck({ ...row('active', 5 * 24), cadenceMinutes: 7 * 1440 }, NOW)).toBe(false);
  });

  it('MP-14-7a show more adds 10 and is absent when nothing is hidden', async () => {
    const { page } = await open();
    expect(page.find('[data-fleet-showing]')?.textContent).toContain('Showing 10 of 14');
    expect(page.find('[data-fleet-more]')?.textContent).toContain('Show 4 more');
    await page.click('[data-fleet-more]');
    expect(page.find('[data-fleet-more]')).toBeNull();
    await page.unmount();
    // With more than 10 still hidden, one press adds a full 10.
    const wide = await mount(
      <ConnectionsScreen
        client={clientFor(server(), 'charlie')}
        grantKey="charlie:a@x:0"
        now={() => NOW}
      />,
    );
    await tick();
    expect(shownIds(wide)).toHaveLength(10);
    expect(wide.find('[data-fleet-more]')?.textContent).toContain('Show 10 more');
    await wide.click('[data-fleet-more]');
    expect(shownIds(wide)).toHaveLength(20);
    expect(wide.find('[data-fleet-showing]')?.textContent).toContain('Showing 20 of 25');
    expect(wide.find('[data-fleet-more]')?.textContent).toContain('Show 5 more');
    await wide.click('[data-fleet-more]');
    expect(shownIds(wide)).toHaveLength(25);
    expect(wide.find('[data-fleet-more]')).toBeNull();
    await wide.unmount();
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
    // A degraded source has failed, so its Sync now shows too.
    await page.click('[data-connection="c-10"]');
    expect(page.find('[data-connection-detail="c-10"] [data-action="sync"]')).not.toBeNull();
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
    const { page, stub } = await open();
    const before = stub.sent.length;
    await page.click('[data-fleet-facet="degraded"]');
    await page.click('[data-fleet-facet="all"]');
    await page.click('[data-fleet-sort="freshness"]');
    await page.click('[data-fleet-sort="freshness"]');
    await page.click('[data-connection="c-11"]');
    await page.click('[data-connection="c-11"]');
    await page.click('[data-fleet-more]');
    await tick();
    expect(stub.sent.length).toBe(before);
    await page.unmount();
  });

  it('MP-14-7a a repair whose answer was lost is sent again as the same attempt, and is disabled while in flight', async () => {
    const { page, stub } = await open();
    await page.click('[data-connection="c-11"]');
    stub.nextRepair('lost');
    await page.click('[data-connection-repair="c-11"]');
    await tick();
    expect(page.find('[data-connection-detail="c-11"] [role="alert"]')?.textContent).toContain(
      'network down',
    );
    const release = stub.holdRepair();
    await page.click('[data-connection-repair="c-11"]');
    await tick();
    const button = page.find('[data-connection-repair="c-11"]') as HTMLButtonElement | null;
    expect(button?.disabled).toBe(true);
    expect(stub.repairIds).toHaveLength(2);
    expect(stub.repairIds[1]).toBe(stub.repairIds[0]);
    release();
    await tick();
    expect(page.find('[data-connection-detail="c-11"]')?.textContent).toContain('Repair started');
    await page.unmount();
  });

  it('MP-14-7a a refused repair is said on its row, and the next press is a new attempt', async () => {
    const { page, stub } = await open();
    await page.click('[data-connection="c-11"]');
    stub.nextRepair('stale');
    await page.click('[data-connection-repair="c-11"]');
    await tick();
    expect(page.find('[data-connection-detail="c-11"] [role="alert"]')?.textContent).toContain(
      'VERSION_STALE',
    );
    await page.click('[data-connection-repair="c-11"]');
    await tick();
    expect(stub.repairIds).toHaveLength(2);
    expect(stub.repairIds[1]).not.toBe(stub.repairIds[0]);
    await page.unmount();
  });

  it('MP-14-7a a change of business draws only the new business fleet, even when the old answer lands late', async () => {
    const stub = server();
    const context = (business: string): ScreenContext<'agency:connections'> => ({
      client: clientFor(stub, business),
      grantKey: `${business}:a@x:0`,
      params: {},
      notice: null,
      storage: null,
      navigate: () => {},
    });
    const page = await mount(SCREENS['agency:connections'](context('alpha')));
    await tick();
    await page.click('[data-fleet-facet="broken"]');
    await page.click('[data-connection="c-11"]');
    expect(page.find('[data-connection-detail="c-11"]')).not.toBeNull();
    // Alpha's repair is still in flight when the business changes to bravo.
    const release = stub.holdRepair();
    await page.click('[data-connection-repair="c-11"]');
    await page.render(SCREENS['agency:connections'](context('bravo')));
    await tick();
    await page.click('[data-connection="b-02"]');
    const bravoRepair = page.find('[data-connection-repair="b-02"]') as HTMLButtonElement | null;
    expect(bravoRepair?.disabled).toBe(false);
    release();
    await tick();
    expect(page.find('[data-connection-detail="b-02"] [role="alert"]')).toBeNull();
    expect(shownIds(page).toSorted()).toStrictEqual(['b-01', 'b-02']);
    expect(page.text()).not.toContain('Source 11');
    expect(page.find('[data-fleet-facet="all"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(page.find('[data-connection-detail="c-11"]')).toBeNull();
    expect(page.find('[data-fleet-banner]')?.textContent).toContain('Bravo source 02');
    expect(page.find('[data-fleet-banner]')?.textContent).not.toContain('Source 11');
    await page.unmount();
  });

  it('MP-14-7a a change of person in one business draws only the new person fleet and repair state', async () => {
    const ada = server(ADA_FLEET);
    const bea = server(BEA_FLEET);
    const context = (stub: Stub, person: string): ScreenContext<'agency:connections'> => ({
      client: clientFor(stub, 'alpha'),
      grantKey: `alpha:${person}:0`,
      params: {},
      notice: null,
      storage: null,
      navigate: () => {},
    });
    const page = await mount(SCREENS['agency:connections'](context(ada, 'ada@example.test')));
    await tick();
    await page.click('[data-fleet-facet="broken"]');
    await page.click('[data-connection="c-01"]');
    expect(page.text()).toContain('Ada canary client');
    // Ada's repair is still in flight when Bea takes the tab.
    const release = ada.holdRepair();
    await page.click('[data-connection-repair="c-01"]');
    await page.render(SCREENS['agency:connections'](context(bea, 'bea@example.test')));
    await tick();
    expect(page.find('[data-fleet-facet="all"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(page.find('[data-connection-detail="c-01"]')).toBeNull();
    await page.click('[data-connection="c-02"]');
    const beaRepair = page.find('[data-connection-repair="c-02"]') as HTMLButtonElement | null;
    expect(beaRepair?.disabled).toBe(false);
    release();
    await tick();
    expect(shownIds(page)).toStrictEqual(['c-02']);
    expect(page.text()).toContain('Bea canary client');
    expect(page.text()).not.toContain('Ada canary client');
    expect(page.find('[data-connection-detail="c-02"] [role="alert"]')).toBeNull();
    expect(bea.sent.some((call) => call.includes('connector/repair'))).toBe(false);
    await page.unmount();
  });

  it('MP-14-7a the open page re-reads the fleet on the 30-second floor, when shown again and when back online', async () => {
    vi.useFakeTimers({ now: NOW });
    let shown: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => shown);
    const stub = server();
    const reads = (): number =>
      stub.sent.filter((call) => call.includes('/connection/fleet')).length;
    const page = await mount(SCREENS['agency:connections'](alphaContext(stub)));
    try {
      await pass(1);
      expect(reads()).toBe(1);
      await page.click('[data-fleet-facet="broken"]');
      await page.click('[data-connection="c-11"]');
      expect(page.find('[data-connection-repair="c-11"]')).not.toBeNull();
      // Another person starts c-11's repair; the open page shows it within 30 s.
      await someoneElseRepairs(stub, 'c-11');
      await pass(FLOOR_MS);
      expect(reads()).toBe(2);
      expect(page.find('[data-connection-detail="c-11"]')?.textContent).toContain('Repair started');
      expect(page.find('[data-fleet-facet="broken"]')?.getAttribute('aria-pressed')).toBe('true');
      // Hidden, the page reads nothing; shown again, it reads at once.
      shown = 'hidden';
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await someoneElseRepairs(stub, 'c-12');
      await pass(FLOOR_MS * 3);
      expect(reads()).toBe(2);
      shown = 'visible';
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await pass(1);
      expect(reads()).toBe(3);
      await page.click('[data-connection="c-12"]');
      expect(page.find('[data-connection-detail="c-12"]')?.textContent).toContain('Repair started');
      // Back online, it reads at once.
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
      await pass(1);
      expect(reads()).toBe(4);
    } finally {
      await page.unmount();
    }
  });

  it('MP-14-7a fleet reads slower than the floor still land: a tick waits for the read in flight', async () => {
    vi.useFakeTimers({ now: NOW });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const stub = server();
    const reads = (): number =>
      stub.sent.filter((call) => call.includes('/connection/fleet')).length;
    const page = await mount(SCREENS['agency:connections'](alphaContext(stub)));
    try {
      await pass(1);
      await page.click('[data-fleet-facet="broken"]');
      await page.click('[data-connection="c-11"]');
      // Another person starts c-11's repair; from now on every fleet answer takes 31 s.
      await someoneElseRepairs(stub, 'c-11');
      stub.delayFleet(31_000);
      // A re-read starts at 30 s; the tick at 60 s comes while it is in flight; it answers at 61 s.
      await pass(FLOOR_MS);
      await pass(FLOOR_MS);
      await pass(1_000);
      expect(page.find('[data-connection-detail="c-11"]')?.textContent).toContain('Repair started');
      expect(reads()).toBe(2);
      // By 121 s the next read, asked at 90 s, has answered.
      await pass(FLOOR_MS * 2);
      expect(reads()).toBe(3);
      expect(page.find('[data-outcome="ready"]')).not.toBeNull();
    } finally {
      await page.unmount();
    }
    // A first read slower than the floor draws the fleet when it answers.
    const slow = server();
    slow.delayFleet(31_000);
    const late = await mount(SCREENS['agency:connections'](alphaContext(slow)));
    try {
      await pass(FLOOR_MS + 1_000);
      expect(shownIds(late)).toHaveLength(10);
    } finally {
      await late.unmount();
    }
  });

  it('MP-14-7a a fleet read that never answers is superseded after three ticks, so a revoke still draws', async () => {
    vi.useFakeTimers({ now: NOW });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const stub = server();
    const reads = (): number =>
      stub.sent.filter((call) => call.includes('/connection/fleet')).length;
    const page = await mount(SCREENS['agency:connections'](alphaContext(stub)));
    try {
      await pass(1);
      // The read asked at 30 s never answers; connection:read is then revoked.
      stub.holdFleet('alpha');
      stub.refuseFleet();
      await pass(FLOOR_MS);
      await pass(FLOOR_MS * 3);
      expect(reads()).toBe(2);
      expect(page.find('[data-outcome="loading"]')).not.toBeNull();
      // Showing the tab again while it waits is not time waited: it asks nothing new.
      for (let shown = 0; shown < 4; shown += 1) {
        act(() => {
          document.dispatchEvent(new Event('visibilitychange'));
        });
      }
      await pass(1);
      expect(reads()).toBe(2);
      // The fourth tick in its wait asks again, and the refusal draws.
      await pass(FLOOR_MS);
      expect(reads()).toBe(3);
      expect(page.find('[data-outcome="denied"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
      expect(page.all('[data-connection]')).toHaveLength(0);
    } finally {
      await page.unmount();
    }
  });

  it('MP-14-7a a re-read on the floor that is refused drops the drawn fleet', async () => {
    vi.useFakeTimers({ now: NOW });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const stub = server();
    const page = await mount(SCREENS['agency:connections'](alphaContext(stub)));
    try {
      await pass(1);
      expect(shownIds(page)).toHaveLength(10);
      stub.refuseFleet();
      await pass(FLOOR_MS);
      expect(page.find('[data-outcome="denied"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
      expect(page.all('[data-connection]')).toHaveLength(0);
      expect(page.find('[data-fleet-marker]')).toBeNull();
    } finally {
      await page.unmount();
    }
  });

  it('MP-14-7a a refused fleet read says so, and draws no rows', async () => {
    const refusing = ((): Promise<Response> =>
      Promise.resolve(
        json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403),
      )) as typeof fetch;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: refusing,
    });
    const page = await mount(<ConnectionsScreen client={client} grantKey="alpha:a@x:0" />);
    await tick();
    expect(page.find('[data-outcome="denied"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(page.all('[data-connection]')).toHaveLength(0);
    expect(page.find('[data-fleet-marker]')).toBeNull();
    await page.unmount();
  });

  it('MP-14-7a an authorised empty fleet draws the empty state, not an empty table', async () => {
    const empty = ((): Promise<Response> =>
      Promise.resolve(json(fleetOf([], new Set())))) as typeof fetch;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: empty,
    });
    const page = await mount(
      <ConnectionsScreen client={client} grantKey="alpha:a@x:0" now={() => NOW} />,
    );
    await tick();
    expect(page.find('[data-outcome="empty"]')?.textContent).toContain('No connectors yet');
    expect(page.find('[data-fleet-tiles]')).toBeNull();
    expect(page.find('[data-fleet-showing]')).toBeNull();
    expect(page.find('[data-not-connected="band-health"]')).not.toBeNull();
    await page.unmount();
  });

  it('MP-14-7a an unavailable read, or a refused re-read after a fleet, draws no marker', async () => {
    const fleetAnswers = [
      () => json({ error: 'down' }, 503),
      () => json(fleetOf(ROWS, new Set())),
      () => json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403),
    ];
    const scripted = ((url: string | URL): Promise<Response> => {
      const at = String(url);
      if (at.endsWith('/connection/fleet'))
        return Promise.resolve((fleetAnswers.shift() as () => Response)());
      return Promise.resolve(
        json({
          ok: true,
          recordId: 'r-1',
          revision: 1,
          detail: { repairId: 'r-1', connectionId: 'c-11', state: 'awaiting approval' },
        }),
      );
    }) as typeof fetch;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: scripted,
    });
    const page = await mount(
      <ConnectionsScreen client={client} grantKey="alpha:a@x:0" now={() => NOW} />,
    );
    await tick();
    expect(page.find('[data-outcome="unavailable"]')).not.toBeNull();
    expect(page.find('[data-fleet-marker]')).toBeNull();
    await page.click('[data-outcome="unavailable"] button');
    await tick();
    expect(page.find('[data-fleet-marker]')).not.toBeNull();
    // The repair's answer re-reads the fleet, and that re-read is refused.
    await page.click('[data-fleet-facet="broken"]');
    await page.click('[data-connection="c-11"]');
    await page.click('[data-connection-repair="c-11"]');
    await tick();
    expect(page.find('[data-outcome="denied"]')).not.toBeNull();
    expect(page.find('[data-fleet-marker]')).toBeNull();
    await page.unmount();
  });
});
