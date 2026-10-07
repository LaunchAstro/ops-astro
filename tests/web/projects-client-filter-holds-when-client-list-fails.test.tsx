// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A Projects board at a client filter (a Clients row door) offers that client
// once `client.list` names it, even with no row. When that read fails, by an
// outage or a refusal, the requested filter still holds: the board never
// widens to other clients' work, and the failed read says so, with a retry
// where one can help.

import { describe, expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { clientNamesOf } from '../../apps/web/src/screens/projects/client-names.ts';
import type { ClientListResult } from '../../packages/core-wire/src/index.ts';
import { facetId } from '../../packages/ui/src/board/project-facets.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { json, refused, tick } from './work-log-stand-in.tsx';

const SUMMIT = { clientId: 'c-summit', name: 'Summit Allied' };
/** A client the reader reaches with no task on the board. */
const QUIET = { clientId: 'c-quiet', name: 'Quiet Clinic' };
const QUIET_BOARD = `/projects/?${new URLSearchParams({ f: facetId('client', QUIET.name) }).toString()}`;

const SUMMIT_TASK = {
  id: '00000000-0000-4000-8000-000000000001',
  key: 'T-1',
  title: 'Summit intake form',
  state: { id: 's-1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  rank: { number: null, score: null, calc: 'not ranked' },
  stage: null,
  clientSet: true,
  client: SUMMIT,
  actualMinutes: 0,
  estimateMinutes: null,
  category: null,
  pageLink: null,
  statePosition: 1,
  waitReason: null,
  awaitingDecision: false,
};

/** The board with Summit's one task; `client.list` answers each read with the next answer. */
function server(clients: (Response | Promise<Response>)[]) {
  let listed = 0;
  const fetch = ((url: string | URL): Promise<Response> => {
    const at = String(url);
    if (at.endsWith('/task/board'))
      return Promise.resolve(
        json({ ok: true, tasks: [SUMMIT_TASK], changedAt: null, viewer: null }),
      );
    if (at.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (at.endsWith('/client/list')) {
      listed += 1;
      const next = clients.shift();
      return next === undefined ? new Promise<Response>(() => {}) : Promise.resolve(next);
    }
    return new Promise<Response>(() => {});
  }) as unknown as typeof globalThis.fetch;
  return { fetch, listed: () => listed };
}

/** A dock panel's Projects at `address`; one client across renders, so a re-render walks the same instance. */
const panel = (client: OperationsClient, address: string) => (
  <Projects client={client} grantKey="alpha:owner" navigate={() => {}} address={address} inPanel />
);

const clientFor = (fetch: typeof globalThis.fetch): OperationsClient =>
  new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });

async function board(fetch: typeof globalThis.fetch): Promise<Mounted> {
  const view = await mount(panel(clientFor(fetch), QUIET_BOARD));
  await tick();
  await tick();
  return view;
}

/** Every subtree committed into `host` from now on that says `text`; `drain` stops watching and lists them. */
function committed(host: HTMLElement, text: string): { drain: () => readonly string[] } {
  const seen: string[] = [];
  const note = (records: readonly MutationRecord[]): void => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (node.textContent?.includes(text) === true) seen.push(node.nodeName);
  };
  const observer = new MutationObserver(note);
  observer.observe(host, { childList: true, subtree: true });
  return {
    drain: () => {
      note(observer.takeRecords());
      observer.disconnect();
      return seen;
    },
  };
}

const filters = (view: Mounted): string => view.find('.cbd__filters')?.textContent ?? '';

describe('Projects at a client filter when client.list fails', () => {
  it('an outage keeps the requested client’s filter, shows no other client’s work, and offers a retry', async () => {
    const api = server([
      new Response(null, { status: 503 }),
      json({ ok: true, clients: [QUIET, SUMMIT] }),
    ]);
    const view = await board(api.fetch);

    expect(view.text()).not.toContain('Summit intake form');
    expect(filters(view)).toContain('Quiet Clinic');
    const failed = view.find('[data-outcome="unavailable"]');
    expect(failed?.textContent).toContain('could not be read');

    await view.click('[data-outcome="unavailable"] button');
    await tick();
    expect(api.listed()).toBe(2);
    expect(view.find('[data-outcome="unavailable"]')).toBeNull();
    expect(view.text()).not.toContain('Summit intake form');
    expect(filters(view)).toContain('Quiet Clinic');
    await view.unmount();
  });

  it('a refusal keeps the requested client’s filter, shows no other client’s work, and says it was refused', async () => {
    const api = server([json(refused('SCOPE_NOT_GRANTED', ['client']), 403)]);
    const view = await board(api.fetch);

    expect(view.text()).not.toContain('Summit intake form');
    expect(filters(view)).toContain('Quiet Clinic');
    expect(view.find('[data-outcome="denied"]')?.textContent).toContain('not permitted');
    await view.unmount();
  });
});

describe('Projects at a client filter when client.list answers late or without its list', () => {
  it('a successful answer with no client list keeps the requested filter, shows no other client’s work, and says it failed', async () => {
    const api = server([json({ ok: true })]);
    const view = await board(api.fetch);

    expect(view.text()).not.toContain('Summit intake form');
    expect(filters(view)).toContain('Quiet Clinic');
    expect(view.find('[data-outcome="unavailable"]')?.textContent).toContain('could not be read');
    await view.unmount();
  });

  it('a ready state with no client list keeps the address’s client filters, never none', () => {
    const listless = { ok: true } as unknown as ClientListResult;
    const ready = {
      outcome: 'ready',
      value: listless,
      refusal: null,
      because: null,
      grantKey: 'alpha:owner',
    } as const;
    expect(clientNamesOf(ready, QUIET_BOARD.slice('/projects/?'.length))).toEqual([QUIET.name]);
  });

  it('a panel walked to a quiet client never commits another client’s work, while client.list is out or after it fails', async () => {
    let release: ((answer: Response) => void) | undefined;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const api = server([held]);
    const client = clientFor(api.fetch);
    const view = await mount(panel(client, '/projects/'));
    await tick();
    await tick();
    expect(view.text()).toContain('Summit intake form');

    const summit = committed(view.host, 'Summit intake form');
    await view.render(panel(client, QUIET_BOARD));
    await tick();
    expect(api.listed()).toBe(1);
    release?.(new Response(null, { status: 503 }));
    await tick();
    await tick();

    expect(summit.drain()).toEqual([]);
    expect(view.text()).not.toContain('Summit intake form');
    expect(filters(view)).toContain('Quiet Clinic');
    expect(view.find('[data-outcome="unavailable"]')?.textContent).toContain('could not be read');
    await view.unmount();
  });
});
