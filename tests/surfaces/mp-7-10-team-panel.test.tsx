// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-10 (#470) on the page: the Team panel, reached from its dock tab, shows
// the people strip with each teammate's availability as a word, and the person
// sets their own with a reason. The server behind it is a stand-in holding one
// business's staff; the real route and read are proven in
// `tests/api/mp-7-10-availability.test.ts`.

import { act } from 'react';
import { expect, it } from 'vitest';
import { TeamScreen } from '../../apps/web/src/screens/Team.tsx';
import { PANELS } from '../../apps/web/src/panels.ts';
import { pathTo } from '../../apps/web/src/routes.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Availability = { state: 'available' | 'away'; reason: string | null } | null;

/** Two teammates: me, available, and Bo, away at a shoot. */
function server() {
  const people: { personId: string; name: string; availability: Availability }[] = [
    { personId: 'p-me', name: 'Ana Bell', availability: null },
    { personId: 'p-bo', name: 'Bo Reyes', availability: { state: 'away', reason: 'On a shoot' } },
  ];
  const sent: unknown[] = [];
  const route = (at: string, body: string): Response => {
    if (at.endsWith('/team/list')) return json({ ok: true, you: 'p-me', people });
    if (at.endsWith('/account/availability')) {
      const wanted = JSON.parse(body) as { state: 'available' | 'away'; reason?: string };
      sent.push(wanted);
      const availability = { state: wanted.state, reason: wanted.reason ?? null };
      const me = people[0];
      if (me !== undefined) me.availability = availability;
      return json({ availability });
    }
    throw new Error(`unrouted ${at}`);
  };
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    return route(String(url), String(init?.body));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  });
};

async function until(say: string, check: () => boolean, deadline = Date.now() + 2000) {
  if (check()) return;
  if (Date.now() > deadline) throw new Error(`never happened: ${say}`);
  await settle();
  await until(say, check, deadline);
}

const team = async () => {
  const api = server();
  const client = new OperationsClient({
    origin: '',
    businessKey: 'b',
    token: 't',
    fetch: api.fetch,
  });
  const page = await mount(<TeamScreen client={client} grantKey="b:me" />);
  await until('the strip', () => page.find('[data-team="people"]') !== null);
  return { api, page };
};

const entry = (page: Awaited<ReturnType<typeof team>>['page'], id: string): string =>
  page.find(`[data-person-id="${id}"]`)?.textContent ?? '';

it('MP-7-10 the Team panel opens from its dock tab with the people strip and availability', async () => {
  const tab = PANELS.find((panel) => panel.id === 'team');
  expect(tab?.route === null ? null : pathTo(tab?.route ?? 'agency:settings')).toBe('/team');
  const { page } = await team();
  expect(page.all('[data-team="people"] [data-person-id]')).toHaveLength(2);
  expect(page.find('[data-availability="form"]')).not.toBeNull();
  // Room for the conversations C71-D and C71-G draw next; none drawn yet.
  expect(page.find('[data-team="conversations"]')).not.toBeNull();
  await page.unmount();
});

it('MP-7-10 people strip with away state as a word', async () => {
  const { page } = await team();
  expect(entry(page, 'p-bo')).toContain('Away');
  expect(entry(page, 'p-bo')).toContain('On a shoot');
  expect(entry(page, 'p-me')).not.toContain('Away');
  await page.unmount();
});

it('MP-7-10 CS-7.27: the person sets their own availability with a reason', async () => {
  const { api, page } = await team();
  await page.choose('#availability-state', 'away');
  await page.type('#availability-reason', 'At the dentist until 2');
  await page.click('[data-availability="save"]');
  await until('my entry says Away', () => entry(page, 'p-me').includes('Away'));
  expect(api.sent).toEqual([{ state: 'away', reason: 'At the dentist until 2' }]);
  expect(entry(page, 'p-me')).toContain('At the dentist until 2');

  // Back to available: no reason goes with it.
  await page.choose('#availability-state', 'available');
  await page.click('[data-availability="save"]');
  await until('my entry is plain again', () => !entry(page, 'p-me').includes('Away'));
  expect(api.sent.at(-1)).toEqual({ state: 'available' });
  await page.unmount();
});
