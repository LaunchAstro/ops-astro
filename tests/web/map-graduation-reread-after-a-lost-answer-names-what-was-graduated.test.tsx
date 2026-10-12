// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { MapScreen } from '../../apps/web/src/screens/Map.tsx';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import type { Member } from '../commands/fixture.ts';
import { tokenFor } from '../api/fixture.ts';
import { asBrowser } from '../support/sign-in.ts';
import { chart } from './wayfinder-web.tsx';
import { until } from './screen-until.tsx';
import { mount } from '../surfaces/mount.tsx';
import { serverUrl } from '../acceptance/world.ts';

let world: CliWorld;
let lead: Member;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await cliWorld('sol1378grad', 'sol1378grad');
  lead = await world.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
}, 180_000);
afterAll(async () => {
  if (serverUrl !== undefined) await world?.drop();
});

/* eslint-disable max-lines-per-function, unicorn/prefer-dom-node-dataset -- Sol's proof, kept as written */
// Sol's proof on #1378 (round 2), retitled by what it proves; its body is Sol's.
it.skipIf(serverUrl === undefined)(
  'a live reread after a lost graduation answer does not label committed titles ungraduated',
  async () => {
    const m = await chart(world, lead, 'lost graduation', [], ['graduate this patch']);
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let lose = true;
    const fetch = asBrowser(await tokenFor(lead.presented.subject), async (url, init) => {
      if (url.includes('/live?')) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      const answer = await world.api.fetch(new Request(url, init));
      if (url.endsWith('/map/graduate') && lose) {
        lose = false;
        expect(answer.ok).toBe(true);
        throw new TypeError('lost committed graduation answer');
      }
      return answer;
    });
    const client = new OperationsClient({
      origin: 'http://api.test',
      businessKey: world.key,
      signedIn: true,
      fetch,
    });
    const page = await mount(
      <MapScreen client={client} grantKey={lead.presented.subject} mapKey={m.key} />,
    );
    await until(
      page,
      () => page.find('[data-map-section="destination"]') !== null && stream !== undefined,
      'map and live stream',
    );
    await page.click('#map-tab-fog');
    const button = page.find('button[data-graduate]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('patch missing');
    await page.click('button[data-graduate]');
    await page.type('input[name="ticket-title-0"]', 'committed graduation canary');
    await page.click('button[data-graduate-save]');
    await until(page, () => page.find('[data-map-failure]') !== null, 'lost answer');
    const read = (await world.read(lead, { read: 'map.view', recordId: m.map })) as {
      map: { tickets: Array<{ title: string }> };
    };
    expect(read.map.tickets.map((ticket) => ticket.title)).toContain('committed graduation canary');
    const revision = String(await world.revisionOf(m.map));
    stream?.enqueue(new TextEncoder().encode('event: invalidate\ndata: board\n\n'));
    await until(
      page,
      () => page.find('[data-map]')?.getAttribute('data-revision') === revision,
      'live reread',
    );
    const gone = page.find('[data-graduate-gone]');
    expect(
      gone?.textContent ?? '',
      'a stored title must not be listed as not graduated',
    ).not.toContain('committed graduation canary');
  },
);
/* eslint-enable max-lines-per-function, unicorn/prefer-dom-node-dataset */
