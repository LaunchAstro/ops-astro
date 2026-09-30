// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one ticket's browser cases, named after its checklist lines */
//
// MP-14-8, the browser's half of Connections & signal sections 006 to 008:
// grants in their groups with the TTL countdown, tripwires in words, and the
// night round's cites. The server is a stub that answers `connection.fleet`
// with an empty fleet and `connection.signal` with the case's own body, and
// records every call, so the cases can prove the sections send nothing.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionsScreen } from '../../apps/web/src/screens/Connections.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type {
  ConnectionSignalResult,
  GrantView,
  NightStepView,
  TripwireView,
} from '../../packages/core-wire/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const minutesFromNow = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

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

function grant(id: string, state: GrantView['state'], minutesLeft: number): GrantView {
  return {
    id,
    agentId: `${id}-agent-0000-0000-000000000000`,
    purpose: 'band_update',
    collections: ['task'],
    access: id.endsWith('x') ? 'exec' : 'read',
    client: id.startsWith('fleet') ? null : { id: `k-${id}`, label: `Client ${id}` },
    grantedAt: minutesFromNow(-120),
    expiresAt: minutesFromNow(minutesLeft),
    endedAt: state === 'taken_back' ? minutesFromNow(-30) : null,
    revocationCause: state === 'taken_back' ? 'delegation_revoked' : null,
    state,
    redemptions: id === 'unused' ? 0 : 112,
  };
}

function tripwire(id: string, extra: Partial<TripwireView>): TripwireView {
  return {
    id,
    what: `Check ${id}`,
    rule: `fires when ${id} trips`,
    watching: 'every lease',
    state: 'armed',
    blockedReason: null,
    firedCount: 0,
    lastFiredAt: null,
    filedItem: null,
    filedNothing: null,
    note: null,
    ...extra,
  };
}

function step(id: string, tone: NightStepView['tone'], cite: NightStepView['cite']): NightStepView {
  return {
    id,
    at: minutesFromNow(-600),
    tone,
    what: `Step ${id}`,
    who: 'night.reader',
    say: 'said',
    cite,
  };
}

function signalBody(grants: readonly GrantView[], badSteps = 1): ConnectionSignalResult {
  const tripwires = [
    tripwire('fired', { firedCount: 2, lastFiredAt: minutesFromNow(-180), filedItem: 'AT-10' }),
    tripwire('quiet', {
      firedCount: 3,
      lastFiredAt: minutesFromNow(-60),
      filedNothing: 'already queued',
    }),
    tripwire('never', {}),
    tripwire('dead', {
      state: 'cannot_be_armed',
      blockedReason: 'the broker does not record reach',
    }),
  ];
  const steps = [
    step('open', 'plain', null),
    step('lease', 'plain', { kind: 'grants', ref: null, label: 'GR-1' }),
    step('watch', 'watch', { kind: 'tripwires', ref: null, label: 'TW-1' }),
    step('scan', 'plain', { kind: 'exceptions', ref: null, label: 'SC-1' }),
    ...Array.from({ length: badSteps }, (_, n) =>
      step(`bad-${n}`, 'bad', { kind: 'task', ref: 'T-7', label: 'The brief' }),
    ),
  ];
  const count = (state: GrantView['state']): number =>
    grants.filter((one) => one.state === state).length;
  return {
    ok: true,
    leases: grants,
    leaseCounts: {
      live: count('live'),
      ranOut: count('ran_out'),
      takenBack: count('taken_back'),
      liveExec: grants.filter((one) => one.state === 'live' && one.access === 'exec').length,
    },
    tripwires,
    tripwireCounts: { armed: 3, cannotBeArmed: 1 },
    nightRound: { roundOn: '2026-09-29', steps, notClean: badSteps },
    roster: [{ agentId: 'live-agent-0000-0000-000000000000', active: true, liveGrants: 1 }],
  };
}

const LIVE_ONLY = [grant('live', 'live', 37), grant('fleetx', 'live', 300)];
const ALL = [...LIVE_ONLY, grant('unused', 'ran_out', -60), grant('fleet-taken', 'taken_back', 90)];

const opened: Mounted[] = [];

async function open(
  signal: ConnectionSignalResult,
): Promise<{ readonly page: Mounted; readonly sent: string[] }> {
  const sent: string[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    sent.push(`${at} ${String(init?.body ?? '')}`);
    if (at.endsWith('/connection/signal')) return Promise.resolve(json(signal));
    if (at.endsWith('/connection/fleet')) {
      return Promise.resolve(
        json({
          ok: true,
          connections: [],
          counts: { all: 0, active: 0, degraded: 0, broken: 0, clientConnections: 0 },
        }),
      );
    }
    return Promise.resolve(json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404));
  }) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const page = await mount(<ConnectionsScreen client={client} now={() => NOW} />);
  opened.push(page);
  await tick();
  return { page, sent };
}

// A case that fails before its own unmount leaves its page behind; take it
// down here so the next case starts on an empty document.
afterEach(async () => {
  for (const page of opened.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one page at a time
    if (page.host.isConnected) await page.unmount();
  }
});

const text = (page: Mounted, selector: string): string => page.all(selector)[0]?.textContent ?? '';

// eslint-disable-next-line max-lines-per-function -- one stub server, the cases that share it
describe('MP-14-8 Connections & signal: grants, tripwires and the night round', () => {
  it('MP-14-8 owner check: who holds what access shows, and each filed tripwire carries its link', async () => {
    const { page } = await open(signalBody(ALL));
    const live = page.find('[data-grant="live"]');
    expect(live?.textContent).toContain('live-age');
    expect(live?.textContent).toContain('band_update');
    expect(live?.textContent).toContain('Client live');
    expect(live?.querySelector('[data-grant-access]')?.textContent).toBe('read');
    expect(text(page, '[data-grant="fleetx"]')).toContain('Fleet · every client');
    expect(page.find('[data-grant="fleetx"] [data-grant-access]')?.textContent).toBe('exec');
    expect(page.find('[data-tripwire="fired"] [data-tripwire-filed]')?.textContent).toContain(
      'AT-10',
    );
    await page.unmount();
  });

  it('MP-14-8 groups drawn only when they have rows', async () => {
    const all = await open(signalBody(ALL));
    for (const group of ['live', 'ran_out', 'taken_back']) {
      expect(all.page.find(`[data-grant-group="${group}"]`)).not.toBeNull();
    }
    expect(text(all.page, '[data-grant-group="taken_back"]')).toContain('delegation revoked');
    await all.page.unmount();
    const liveOnly = await open(signalBody(LIVE_ONLY));
    expect(liveOnly.page.find('[data-grant-group="live"]')).not.toBeNull();
    expect(liveOnly.page.find('[data-grant-group="ran_out"]')).toBeNull();
    expect(liveOnly.page.find('[data-grant-group="taken_back"]')).toBeNull();
    await liveOnly.page.unmount();
    const none = await open(signalBody([]));
    expect(none.page.all('[data-grant-group]')).toHaveLength(0);
    expect(text(none.page, '#grants')).toContain('No leases on the ledger');
    await none.page.unmount();
  });

  it('MP-14-8 the TTL countdown turns warning under an hour', async () => {
    const { page } = await open(signalBody(ALL));
    const soon = page.find('[data-grant="live"] [data-grant-ttl]') as HTMLElement | null;
    expect(soon?.textContent).toBe('37m left');
    expect(soon?.dataset['tone']).toBe('warn');
    const later = page.find('[data-grant="fleetx"] [data-grant-ttl]') as HTMLElement | null;
    expect(later?.textContent).toBe('5h 0m left');
    expect(later?.dataset['tone']).toBe('plain');
    expect(later?.title).toContain('Issued');
    expect(text(page, '[data-grant="unused"] [data-grant-ttl]')).toBe('Ran out');
    expect(text(page, '[data-grant="fleet-taken"] [data-grant-ttl]')).toBe('Taken back');
    await page.unmount();
  });

  it('MP-14-8 never-fired and unarmable rows use words, never 0', async () => {
    const { page } = await open(signalBody(ALL));
    expect(text(page, '[data-tripwire="never"] [data-tripwire-fired]')).toBe('Has never fired');
    const dead = page.find('[data-tripwire="dead"]') as HTMLElement | null;
    expect(dead?.dataset['state']).toBe('cannot_be_armed');
    expect(dead?.textContent).toContain('Cannot be armed');
    expect(dead?.textContent).toContain('the broker does not record reach');
    for (const id of ['never', 'dead']) {
      expect(page.find(`[data-tripwire="${id}"]`)?.textContent).not.toMatch(/\b0\b/u);
    }
    expect(text(page, '[data-grant="unused"] [data-grant-reads]')).toBe('Never redeemed');
    expect(text(page, '[data-grant="live"] [data-grant-reads]')).toBe('112 reads');
    expect(text(page, '[data-tripwire="quiet"] [data-tripwire-filed]')).toBe(
      'Filed nothing: already queued',
    );
    await page.unmount();
  });

  it('MP-14-8 cites navigate in-page', async () => {
    const { page } = await open(signalBody(ALL));
    expect(page.find('#grants')).not.toBeNull();
    expect(page.find('#tripwires')).not.toBeNull();
    expect(page.find('#night-round')).not.toBeNull();
    const cite = (id: string): HTMLAnchorElement | null =>
      page.find(`[data-night-step="${id}"] [data-night-cite]`) as HTMLAnchorElement | null;
    expect(cite('lease')?.getAttribute('href')).toBe('#grants');
    expect(cite('watch')?.getAttribute('href')).toBe('#tripwires');
    expect(cite('bad-0')?.getAttribute('href')).toBe('/task/T-7');
    // Exceptions is MP-14-10's section: until it is on the page the cite is
    // flat text, never a link to an anchor that is not there.
    const scan = page.find('[data-night-step="scan"] [data-night-cite]');
    expect(scan?.tagName).not.toBe('A');
    expect(scan?.textContent).toBe('SC-1');
    expect(text(page, '[data-night-step="open"]')).toContain('Step open');
    expect(page.find('[data-night-step="open"] [data-night-cite]')).toBeNull();
    await page.unmount();
  });

  it('MP-14-8 filed tripwires carry their feed link, drawn unavailable until MP-14-4 builds the attention feed', async () => {
    const { page } = await open(signalBody(ALL));
    const filed = page.find(
      '[data-tripwire="fired"] [data-tripwire-filed] [data-feed-link]',
    ) as HTMLElement | null;
    expect(filed?.textContent).toContain('AT-10');
    expect(filed?.getAttribute('aria-disabled')).toBe('true');
    expect(filed?.getAttribute('href')).toBeNull();
    expect(filed?.title).toContain('MP-14-4');
    await page.unmount();
  });

  it('MP-14-8 CS-14.14: the sections are doors and navigation only, and send nothing', async () => {
    const { page, sent } = await open(signalBody(ALL));
    for (const section of ['#grants', '#tripwires', '#night-round']) {
      expect(page.all(section)[0]?.querySelectorAll('button:not([disabled])')).toHaveLength(0);
    }
    const before = sent.length;
    for (const selector of [
      '[data-night-step="lease"] [data-night-cite]',
      '[data-tripwire="fired"] [data-feed-link]',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one click at a time
      await page.click(selector);
    }
    expect(sent.slice(before)).toStrictEqual([]);
    expect(sent.filter((call) => call.includes('/connection/signal'))).toHaveLength(1);
    await page.unmount();
  });

  it('MP-14-8 the night lede says steps did not go cleanly only when one is bad', async () => {
    const bad = await open(signalBody(ALL, 2));
    expect(text(bad.page, '[data-night-lede]')).toContain('2 steps did not go cleanly');
    expect(bad.page.all('[data-night-step] [data-tone="bad"]')).toHaveLength(2);
    await bad.page.unmount();
    const clean = await open(signalBody(ALL, 0));
    expect(text(clean.page, '[data-night-lede]')).not.toContain('did not go cleanly');
    expect(text(clean.page, '[data-night-lede]')).toContain('23:00');
    await clean.page.unmount();
  });

  it('MP-14-8 the roster lists each agent with what it holds', async () => {
    const { page } = await open(signalBody(ALL));
    const row = page.find('[data-roster="live-agent-0000-0000-000000000000"]');
    expect(row?.textContent).toContain('Holding 1 lease');
    await page.unmount();
  });
});
