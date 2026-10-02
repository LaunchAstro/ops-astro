// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// CS-7.29 (MP-7-3, FA-DOCK-61): the client name in an inbox group head opens
// that client in the Clients panel by the gesture law, a plain press solo and
// Shift beside. The Clients panel, given a place naming a client, reads
// `client.list` (C32) and marks that client, or says in a sentence it is not in
// the reader's book. A client the reader does not reach is never named: the
// read leaves it out, so neither the head nor the panel draws anything of it.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { clientsAt } from '../../apps/web/src/routes.ts';
import { ClientsScreen } from '../../apps/web/src/screens/Clients.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';
import { json, open } from './mp-2-1-support.tsx';

const ZENITH = { clientId: 'c-zenith', name: 'Zenith Physio' };
const SUMMIT = { clientId: 'c-summit', name: 'Summit Allied' };
/** Another business's client: its own business's read names it, alpha's never does. */
const FOREIGN = { clientId: 'c-bravo-only', name: 'Bravo Plumbing' };

const entry = (id: string, key: string, client?: { clientId: string; name: string }) => ({
  id,
  reason: 'assignment',
  workState: 'open',
  access: 'readable',
  owed: true,
  counted: true,
  raisedAt: `2026-09-30T0${id}:00:00.000Z`,
  closedAt: null,
  seenAt: null,
  lastDelivery: null,
  task: { key, title: `Task ${key}` },
  ...(client === undefined ? {} : { client }),
});

/** Alpha's server: its inbox, and the clients alpha's grants reach. Anything else is held open. */
const alpha: typeof globalThis.fetch = (url) => {
  const path = String(url);
  if (path.endsWith('/api/b/alpha/inbox/read'))
    return Promise.resolve(
      json({ ok: true, inbox: [entry('1', 'T-1', ZENITH), entry('2', 'T-2')] }),
    );
  if (path.endsWith('/api/b/alpha/inbox/count'))
    return Promise.resolve(json({ ok: true, owed: 2 }));
  if (path.endsWith('/api/b/alpha/client/list'))
    return Promise.resolve(json({ ok: true, clients: [SUMMIT, ZENITH] }));
  return new Promise<Response>(() => {});
};

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

async function inbox(): Promise<Mounted> {
  const { view } = await open('/inbox/', { fetch: alpha });
  live.push(view);
  for (let turn = 0; turn < 4; turn += 1) {
    // eslint-disable-next-line no-await-in-loop -- each answer lands before the next read
    await settle();
  }
  return view;
}

async function press(target: Element | null, shiftKey = false): Promise<void> {
  if (target === null) throw new Error('no target');
  await act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }));
  });
  for (let turn = 0; turn < 3; turn += 1) {
    // eslint-disable-next-line no-await-in-loop -- the panel's read lands
    await settle();
  }
}

const openIds = (page: Mounted): (string | undefined)[] =>
  page.all('.dpanel').map((each) => (each as HTMLElement).dataset['panelId']);

const head = (page: Mounted, name: string): Element | null =>
  page.all('.content .nt__gname').find((each) => each.textContent === name) ?? null;

describe('CS-7.29 client group head opens the Clients panel by the gesture law', () => {
  it('a client head the reader reaches is a link to the Clients panel at that client', async () => {
    const page = await inbox();
    expect(head(page, 'Zenith Physio')?.tagName).toBe('A');
    expect(head(page, 'Zenith Physio')?.getAttribute('href')).toBe('/clients/?client=c-zenith');
  });

  it('a group naming no client stays a name, not a link', async () => {
    const page = await inbox();
    expect(head(page, 'Your work')?.tagName).toBe('SPAN');
  });

  it('a plain press solos the Clients panel, marking that client', async () => {
    const page = await inbox();
    await press(page.find('.dock__tab[data-panel="settings"]'));
    expect(openIds(page)).toEqual(['settings']);
    await press(head(page, 'Zenith Physio'));
    expect(openIds(page)).toEqual(['clients']);
    const panel = page.find('[data-panel-id="clients"]');
    expect(panel?.querySelector('[data-act="door"]')?.getAttribute('href')).toBe(
      '/clients/?client=c-zenith',
    );
    expect(panel?.querySelector('[aria-current="true"] .clbook__name')?.textContent).toBe(
      'Zenith Physio',
    );
  });

  it('a Shift press opens the Clients panel beside what is open', async () => {
    const page = await inbox();
    await press(page.find('.dock__tab[data-panel="settings"]'));
    await press(head(page, 'Zenith Physio'), true);
    expect(openIds(page)).toEqual(['clients', 'settings']);
  });
});

/** A client whose server answers `client.list` with `clients`, recording each read. */
function listing(clients: readonly unknown[]): { client: OperationsClient; calls: string[] } {
  const calls: string[] = [];
  const client = new OperationsClient({
    origin: 'http://api.test',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (url) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path.endsWith('/client/list')) return Promise.resolve(json({ ok: true, clients }));
      return Promise.resolve(new Response('{}', { status: 404 }));
    },
  });
  return { client, calls };
}

async function panelAt(clientId: string | undefined, reached: readonly unknown[]) {
  const { client, calls } = listing(reached);
  const page = await mount(<ClientsScreen client={client} grantKey="alpha:ada" at={clientId} />);
  live.push(page);
  await settle();
  await settle();
  return { page, calls };
}

describe('CS-7.29 Clients panel at a named client', () => {
  it('marks the client the place names, by its name from client.list', async () => {
    const { page } = await panelAt('c-zenith', [SUMMIT, ZENITH]);
    const marked = page.all('[aria-current="true"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]?.querySelector('.clbook__name')?.textContent).toBe('Zenith Physio');
    expect(marked[0]?.closest('.is-mock')).toBeNull();
    // The made-up book still draws below it, under its mark.
    expect(page.find('.is-mock .clbook__list')).not.toBeNull();
  });

  it('says in a sentence when the named client is not in the book', async () => {
    const { page } = await panelAt('c-gone', [SUMMIT]);
    expect(page.find('[aria-current="true"]')).toBeNull();
    expect(page.find('.clbook__opened')?.textContent).toBe(
      'The client you opened is not in your book.',
    );
  });

  it('with no client named, reads nothing and marks nothing', async () => {
    const { page, calls } = await panelAt(undefined, [SUMMIT]);
    expect(calls).toEqual([]);
    expect(page.find('.clbook__opened')).toBeNull();
  });

  it('the place is the address the dock draws, so the address names the client', () => {
    expect(clientsAt('c-zenith')).toBe('/clients/?client=c-zenith');
    expect(clientsAt('a b/c')).toBe('/clients/?client=a%20b%2Fc');
  });
});

describe('CS-7.29 data separation: a client the reader does not reach is never named', () => {
  it("an entry whose client the read left out draws under the reader's own work, no link", async () => {
    const page = await inbox();
    expect(page.all('.content a.nt__gname').map((each) => each.textContent)).toEqual([
      'Zenith Physio',
    ]);
    expect(page.text()).not.toContain(FOREIGN.name);
  });

  it("the place for another business's client draws nothing of it", async () => {
    const { page } = await panelAt(FOREIGN.clientId, [SUMMIT, ZENITH]);
    expect(page.find('[aria-current="true"]')).toBeNull();
    expect(page.text()).not.toContain(FOREIGN.clientId);
    expect(page.text()).not.toContain(FOREIGN.name);
    expect(page.find('.clbook__opened')?.textContent).toBe(
      'The client you opened is not in your book.',
    );
  });
});
