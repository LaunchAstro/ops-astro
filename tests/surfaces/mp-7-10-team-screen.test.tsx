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

/**
 * Two teammates: me, available, and Bo, away at a shoot. With `hold`, the
 * first availability save reaches the server only when `release` is called,
 * as a slow request does: it is stored then, after anything sent meanwhile.
 */
function server(hold = false) {
  const held: (() => void)[] = [];
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
    if (hold && String(url).endsWith('/account/availability') && held.length === 0) {
      await new Promise<void>((resolve) => {
        held.push(resolve);
      });
    }
    return route(String(url), String(init?.body));
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    sent,
    asked: () => held.length,
    release: () => {
      for (const one of held) one();
    },
  };
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

const team = async (hold = false) => {
  const api = server(hold);
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
  // This stand-in answers no chat read (C71's are proven in c71-c-team-chat-web),
  // so a face opens nothing and no group list or composer is drawn.
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

it('MP-7-10 two quick changes of availability are stored in the order the person made them', async () => {
  const { api, page } = await team(true);
  await page.click('.tmc__me button.tmc__set');
  await page.type('.tmc__me input[name="reason"]', 'At the dentist');
  await page.click('.tmc__me button[type="submit"]');
  await until('the first save has left', () => api.asked() === 1);
  // Its answer has not come, so the line still says in: the person says it again, differently.
  await page.click('.tmc__me button.tmc__set');
  await page.type('.tmc__me input[name="reason"]', 'Out until Friday');
  await page.click('.tmc__me button[type="submit"]');
  await settle();
  api.release();
  await until('both saves stored', () => api.sent.length === 2);
  await until('my line settles', () => mine(page).includes('Out until Friday'));
  expect(api.sent).toEqual([
    { state: 'away', reason: 'At the dentist' },
    { state: 'away', reason: 'Out until Friday' },
  ]);
  await page.unmount();
});

// Sol's proof on #1369 (round 1), retitled by what it proves; its body is Sol's.
it('reopening Team cannot let an older queued availability choice overwrite the latest saved choice', async () => {
  const api = server(true);
  const client = new OperationsClient({
    origin: '',
    businessKey: 'b',
    signedIn: true,
    fetch: api.fetch,
  });
  const page = await mount(<TeamScreen client={client} grantKey="b:me" />);
  try {
    await until('initial strip', () => page.find('.tmc__strip') !== null);
    await page.click('.tmc__me button.tmc__set');
    await page.type('.tmc__me input[name="reason"]', 'First choice');
    await page.click('.tmc__me button[type="submit"]');
    await until('first save held', () => api.asked() === 1);
    await page.click('.tmc__me button.tmc__set');
    await page.type('.tmc__me input[name="reason"]', 'Older queued choice');
    await page.click('.tmc__me button[type="submit"]');
    await page.render(<div>Another page</div>);
    await page.render(<TeamScreen client={client} grantKey="b:me" />);
    await until('reopened strip', () => page.find('.tmc__strip') !== null);
    await page.click('.tmc__me button.tmc__set');
    await page.type('.tmc__me input[name="reason"]', 'Latest choice');
    await page.click('.tmc__me button[type="submit"]');
    await until('latest save stored', () =>
      api.sent.some((body) => JSON.stringify(body).includes('Latest choice')),
    );
    api.release();
    await until('all saves stored', () => api.sent.length === 3);
    await page.render(<div>Another page</div>);
    await page.render(<TeamScreen client={client} grantKey="b:me" />);
    await until('stored availability reread', () => page.find('.tmc__strip') !== null);
    expect(mine(page)).toContain('Latest choice');
    expect(api.sent.at(-1)).toEqual({ state: 'away', reason: 'Latest choice' });
  } finally {
    api.release();
    await settle();
    await page.unmount();
  }
});
