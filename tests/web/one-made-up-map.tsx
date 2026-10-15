// SPDX-License-Identifier: AGPL-3.0-only
//
// One small made-up map, mounted on a client that answers `map.view` and
// `map.frontier` only, for the map screen's display tests. It reaches no
// database, so a test that imports it stays off the database suites.

import type { MapView } from '../../packages/core-wire/src/index.ts';
import { MapScreen } from '../../apps/web/src/screens/Map.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { until } from './screen-until.tsx';

/** Who wrote version 2, as the read carries them: an id, never a name. */
export const WRITER_ID = '7d4c9a0e-5b1f-4c2a-9e3d-1a2b3c4d5e6f';

/** When version 2 was written: 12:36 am on 13 October in Brisbane. */
export const WRITTEN_AT = '2026-10-12T14:36:00.000Z';

const ticket = (id: string, key: string, title: string, type: string) => ({
  id,
  key,
  title,
  type,
  state: 'todo',
  revision: 1,
  blockedBy: [],
});

export const MAP: MapView = {
  id: 'map-1',
  key: 'T-1',
  title: 'Clinic booking map',
  type: 'map',
  owner: null,
  client: null,
  clientSet: false,
  version: 2,
  revision: 4,
  destination: { id: 'd-1', kind: 'destination', text: 'Bookings online', ticketId: null },
  notes: null,
  fog: [{ id: 'f-1', kind: 'fog', text: 'Which calendar', ticketId: null }],
  outOfScope: [],
  decisions: [],
  tickets: [
    ticket('t-1', 'T-2', 'Research calendars', 'research'),
    ticket('t-2', 'T-3', 'Build the booking form', 'build'),
  ],
  versions: [
    { version: 1, changed: ['destination'], actorId: WRITER_ID, at: '2026-10-11T23:05:00.000Z' },
    { version: 2, changed: ['fog'], actorId: WRITER_ID, at: WRITTEN_AT },
  ],
};

const ANSWERS: Readonly<Record<string, unknown>> = {
  'map.view': { ok: true, map: MAP },
  'map.frontier': { ok: true, frontier: [MAP.tickets[0]], fog: [] },
};

const client = {
  read: (name: string) => {
    const answer = ANSWERS[name];
    return Promise.resolve(
      answer === undefined ? { refused: true, code: 'NOT_FOUND' } : { ok: true, value: answer },
    );
  },
  mutate: () => Promise.reject(new Error('this map answers reads only')),
} as unknown as OperationsClient;

/** The map drawn, once it has read. */
export async function openMadeUpMap(open: Mounted[]): Promise<Mounted> {
  const page = await mount(<MapScreen client={client} grantKey="made-up" mapKey="T-1" />);
  open.push(page);
  await until(page, () => page.find('[data-map]') !== null, 'the map');
  return page;
}

/** Moves to a view by its tab, matched by attribute: jsdom resolves `#id` document-wide first. */
export async function tab(page: Mounted, view: string): Promise<void> {
  await page.click(`[role="tab"][id="map-tab-${view}"]`);
}
