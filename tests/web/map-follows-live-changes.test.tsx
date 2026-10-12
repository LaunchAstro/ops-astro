// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The map page follows the tab's live channel (C4) as the task page does: a
// change to the map reads the map again, and a change to any task the reader
// may read (a ticket's state or blocking) reads the map and, on the frontier
// view, the frontier again. Fed the harness's made-up answers through a
// client whose live stream the test writes to.

import { afterEach, describe, expect, it } from 'vitest';
import { MapScreen } from '../../apps/web/src/screens/Map.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { until } from './screen-until.tsx';
import { WAYFINDER_READS } from '../visual/made-up-wayfinder.ts';

const open: Mounted[] = [];

afterEach(async () => {
  for (const page of open.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop
    await page.unmount();
  }
});

/** A client answering reads from the made-up set, with a live stream the test writes frames to. */
function liveClient() {
  const asked: string[] = [];
  const encoder = new TextEncoder();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const client = {
    read: (name: string) => {
      asked.push(name);
      const answer = (WAYFINDER_READS as Readonly<Record<string, unknown>>)[name];
      return Promise.resolve(
        answer === undefined ? { refused: true, code: 'NOT_FOUND' } : { ok: true, value: answer },
      );
    },
    mutate: () => Promise.reject(new Error('this map takes no writes')),
    openLive: () =>
      Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
          },
        }),
      ),
  } as unknown as OperationsClient;
  const say = (topic: string) => {
    streams.at(-1)?.enqueue(encoder.encode(`event: invalidate\ndata: ${topic}\n\n`));
  };
  const reads = (name: string) => asked.filter((one) => one === name).length;
  return { client, say, reads, joined: () => streams.length > 0 };
}

async function openMap(client: OperationsClient): Promise<Mounted> {
  const page = await mount(<MapScreen client={client} grantKey="harness" mapKey="T-40" />);
  open.push(page);
  await until(page, () => page.find('[data-map-section="destination"]') !== null, 'the map');
  return page;
}

describe('the map page on the live channel', () => {
  const mapId = WAYFINDER_READS['map.view'].map.id;

  it('reads the map again when the live channel says the map changed', async () => {
    const live = liveClient();
    const page = await openMap(live.client);
    await until(page, live.joined, 'the live stream', 2000);
    expect(live.reads('map.view')).toBe(1);

    live.say(`task:${mapId}`);
    await until(page, () => live.reads('map.view') === 2, 'the live reread');
    await until(page, () => page.find('[data-map-section="destination"]') !== null, 'the map');
  });

  it('reads the map and the open frontier again when a task the reader reads changed', async () => {
    const live = liveClient();
    const page = await openMap(live.client);
    await page.click('[role="tab"][id="map-tab-frontier"]');
    await until(page, () => live.reads('map.frontier') === 1, 'the frontier');
    await until(page, live.joined, 'the live stream', 2000);

    live.say('board');
    await until(
      page,
      () => live.reads('map.view') === 2 && live.reads('map.frontier') === 2,
      'the live rereads',
    );
    await until(page, () => page.find('[data-map-section="frontier"]') !== null, 'the frontier');
  });
});
