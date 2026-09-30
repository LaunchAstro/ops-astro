// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-10 (#470) on the page: the Team panel, reached from its dock tab, is the
// kit's one TeamPanel (`packages/ui`), fed by `team.list` and saving through
// `account/availability`. The strip holds each teammate, never the reader, with
// their availability as a word; the reader sets their own with a reason. The
// server behind it is a stand-in holding one business's staff; the real route
// and read are proven in `tests/api/mp-7-10-availability.test.ts`, and the
// panel's own behaviour in `tests/surfaces/mp-7-10-team-panel.test.tsx`.

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
    signedIn: true,
    fetch: api.fetch,
  });
  const page = await mount(<TeamScreen client={client} grantKey="b:me" />);
  await until('the strip', () => page.find('.tmc__strip') !== null);
  return { api, page };
};

const chip = (page: Awaited<ReturnType<typeof team>>['page'], id: string): Element | null =>
  page.find(`.tmc__strip [data-person="${id}"]`);
const mine = (page: Awaited<ReturnType<typeof team>>['page']): string =>
  page.find('.tmc__me')?.textContent ?? '';

it('MP-7-10 the Team panel opens from its dock tab with the people strip and availability', async () => {
  const tab = PANELS.team;
  expect(tab === undefined ? null : pathTo(tab.route)).toBe('/team');
  const { page } = await team();
  // The kit's panel: the strip holds the reader's teammates, never the reader.
  expect(
    page.all('.tmc__strip [data-person]').map((el) => (el as HTMLElement).dataset['person']),
  ).toEqual(['p-bo']);
  expect(mine(page)).toContain('You are in');
  // Room for the conversations C71-D and C71-G draw next; none drawn yet, so a
  // face opens nothing and no group list or composer is drawn.
  expect(page.find('[data-team="conversations"]')?.childElementCount).toBe(0);
  expect(page.find('.tmc__strip button')).toBeNull();
  expect(page.find('.composer')).toBeNull();
  // No view of a person's work exists yet: the name is plain text, not a door.
  expect(page.find('.tmc__strip a')).toBeNull();
  expect(chip(page, 'p-bo')?.querySelector('.tmc__n')?.textContent).toBe('Bo');
  await page.unmount();
});

it('MP-7-10 people strip with away state as a word', async () => {
  const { page } = await team();
  expect(chip(page, 'p-bo')?.querySelector('.tmc__away')?.textContent).toBe('Away');
  expect(chip(page, 'p-bo')?.querySelector('.tmc__face')?.getAttribute('aria-label')).toBe(
    'Bo Reyes, away: On a shoot',
  );
  expect(chip(page, 'p-me')).toBeNull();
  expect(page.find('.tmc__me span')?.textContent).toBe('You are in');
  await page.unmount();
});

it('MP-7-10 CS-7.27: the person sets their own availability with a reason', async () => {
  const { api, page } = await team();
  await page.click('.tmc__me button.tmc__set');
  await page.type('.tmc__me input[name="reason"]', 'At the dentist until 2');
  await page.click('.tmc__me button[type="submit"]');
  await until('my line says away', () => mine(page).includes('You are away'));
  expect(api.sent).toEqual([{ state: 'away', reason: 'At the dentist until 2' }]);
  expect(mine(page)).toContain('You are away: At the dentist until 2');

  // Back in: no reason goes with it.
  await page.click('.tmc__me button.tmc__back');
  await until('my line is in again', () => mine(page).includes('You are in'));
  expect(api.sent.at(-1)).toEqual({ state: 'available' });
  await page.unmount();
});
