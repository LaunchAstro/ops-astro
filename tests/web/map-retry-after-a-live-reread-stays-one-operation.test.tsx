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
// The proof needs a real database; without one it skips, as the other database suites do.
beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await cliWorld('sol1378', 'sol1378');
  lead = await world.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
}, 180_000);
afterAll(async () => {
  if (serverUrl === undefined) return;
  await world?.drop();
});

/* eslint-disable max-lines-per-function, unicorn/prefer-dom-node-dataset -- Sol's proof, kept as written */
// Sol's proof on #1378 (round 1), retitled by what it proves; its body is Sol's.
it.skipIf(serverUrl === undefined)(
  'a live reread after a lost add answer cannot turn retry into a second add',
  async () => {
    const m = await chart(world, lead, 'live lost reply', [{ ref: 'a', title: 'a', type: 'task' }]);
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let lose = true;
    const requests: Record<string, unknown>[] = [];
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
      if (url.endsWith('/map/revise'))
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const answer = await world.api.fetch(new Request(url, init));
      if (url.endsWith('/map/revise') && lose) {
        lose = false;
        expect(answer.ok).toBe(true);
        throw new TypeError('lost committed answer');
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
    await page.type('input[name="fog"]', 'one fog line canary');
    await page.click('button[data-add="fog"]');
    await until(page, () => page.find('[data-map-failure]') !== null, 'lost answer');
    const committedRevision = String(await world.revisionOf(m.map));
    stream?.enqueue(new TextEncoder().encode('event: invalidate\ndata: board\n\n'));
    await until(
      page,
      () => page.find('[data-map]')?.getAttribute('data-revision') === committedRevision,
      'live reread of committed map',
    );
    expect((page.find('input[name="fog"]') as HTMLInputElement).value).toBe('one fog line canary');
    await page.click('button[data-add="fog"]');
    await until(
      page,
      () => (page.find('input[name="fog"]') as HTMLInputElement | null)?.value === '',
      'retry settlement',
    );
    const lines = page
      .all('[data-map-section="fog"] li')
      .filter((line) => line.textContent?.startsWith('one fog line canary') === true);
    expect(
      lines,
      'the committed operation must occur once despite live revision advancement',
    ).toHaveLength(1);
    expect(requests[1]?.['operationId']).toBe(requests[0]?.['operationId']);
  },
);
/* eslint-enable max-lines-per-function, unicorn/prefer-dom-node-dataset */
