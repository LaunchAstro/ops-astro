// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The map page draws from the width-and-theme harness's made-up wayfinder
// answers (UI-SL14): the same screen the harness photographs at `/map/:key`,
// fed `made-up-wayfinder.ts` through a client that answers reads only. A
// capture of the map then shows its sections, tickets and frontier with rows,
// not the "could not be read" state. The look against W4 stays held (#603).

import { afterEach, describe, expect, it } from 'vitest';
import { MapScreen } from '../../apps/web/src/screens/Map.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { until } from './wayfinder-web.tsx';
import { WAYFINDER_READS } from '../visual/made-up-wayfinder.ts';

const asked: string[] = [];
const open: Mounted[] = [];

/** Answers each read from the made-up set, as the harness's routes do; no writes. */
const client = {
  read: (name: string) => {
    asked.push(name);
    const answer = (WAYFINDER_READS as Readonly<Record<string, unknown>>)[name];
    return Promise.resolve(
      answer === undefined ? { refused: true, code: 'NOT_FOUND' } : { ok: true, value: answer },
    );
  },
  mutate: () => Promise.reject(new Error('the harness answers reads only')),
} as unknown as OperationsClient;

async function openMadeUpMap(): Promise<Mounted> {
  const page = await mount(<MapScreen client={client} grantKey="harness" mapKey="T-1" />);
  open.push(page);
  await until(page, () => page.find('[data-map-section="destination"]') !== null, 'the map');
  return page;
}

afterEach(async () => {
  for (const page of open.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop
    await page.unmount();
  }
  asked.length = 0;
});

describe('the map page on the harness made-up answers', () => {
  it('draws every section of the made-up map, from map.view alone', async () => {
    const page = await openMadeUpMap();
    const { map } = WAYFINDER_READS['map.view'];
    expect(page.text()).toContain(map.title);
    expect(page.text()).toContain(map.destination.text);
    for (const name of ['fog', 'out-of-scope', 'decisions', 'pre-answers', 'history']) {
      expect(page.find(`[data-map-section="${name}"]`), name).not.toBeNull();
    }
    for (const line of [...map.fog, ...map.outOfScope]) expect(page.text()).toContain(line.text);
    expect(asked).toStrictEqual(['map.view']);
  });

  it('draws a row per made-up ticket on the tickets view', async () => {
    const page = await openMadeUpMap();
    await page.click('[role="tab"][id="map-tab-tickets"]');
    const { tickets } = WAYFINDER_READS['map.view'].map;
    expect(
      page.all('[data-ticket-row]').map((row) => (row as HTMLElement).dataset['ticketRow']),
    ).toEqual(tickets.map((ticket) => ticket.id));
  });

  it('draws the made-up frontier from map.frontier on the frontier view', async () => {
    const page = await openMadeUpMap();
    await page.click('[role="tab"][id="map-tab-frontier"]');
    const { frontier } = WAYFINDER_READS['map.frontier'];
    await until(page, () => page.all('[data-ticket]').length > 0, 'the frontier');
    expect(frontier.length).toBeGreaterThan(0);
    for (const ticket of frontier) expect(page.find(`[data-ticket="${ticket.id}"]`)).not.toBeNull();
    expect(asked).toContain('map.frontier');
  });
});
