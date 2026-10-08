// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A Projects board at a client filter (a Clients row door) offers that client
// once `client.list` names it, even with no row. When that read fails, by an
// outage or a refusal, the requested filter still holds: the board never
// widens to other clients' work, and the failed read says so, with a retry
// where one can help.

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { encodeBoardAddress } from '../../apps/web/src/screens/projects/scoped-board.ts';
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

const scopedPerson = 'aaaaaaaa-1111-4111-8111-111111111111';
const scopedClient = 'bbbbbbbb-2222-4222-8222-222222222222';
const boardA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const boardB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function destinationTask(destination: string | null, index: number) {
  return {
    ...SUMMIT_TASK,
    id: `00000000-0000-4000-8000-00000000000${String(index + 1)}`,
    key: `Scope-${String(index + 1)}`,
    title: `Scoped work ${String(index + 1)}`,
    board: destination,
    assignee: { personId: scopedPerson, name: 'Current teammate' },
    client: { clientId: scopedClient, name: 'Current client' },
    due: '2020-01-01',
    priority: 1,
    rank: { number: index + 7, calc: 'reader pool', score: 1 },
    todo: {
      tags: [{ id: 'tag-1', name: 'urgent' }],
      waitingComments: index + 1,
      whoseMove: 'Review',
    },
  };
}
function destinationServer() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let revoked = false;
  let peopleDenied = false;
  let vocabHeld = false;
  let outage = false;
  let outageDependency = 'vocabulary';
  let boardOutage = false;
  const vocabAnswers: (() => void)[] = [];
  const mutations: unknown[] = [];
  let hold: ((answer: Response) => void) | undefined;
  const asked: unknown[] = [];
  const tasks = [boardA, boardB, null].map((destination, index) =>
    destinationTask(destination, index),
  );
  const fetch: typeof globalThis.fetch = (url, init) => {
    const at = String(url);
    if (at.includes('/live?'))
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start: (value) => {
              controller = value;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    if (
      outage &&
      ((at.endsWith('/person/list') && outageDependency !== 'client') ||
        (at.endsWith('/client/list') && outageDependency !== 'person'))
    )
      return Promise.resolve(new Response(null, { status: 503 }));
    if (at.endsWith('/person/list')) {
      if (peopleDenied) return Promise.resolve(json(refused('SCOPE_NOT_GRANTED', ['person']), 403));
      const answer = () =>
        json({
          ok: true,
          persons: revoked ? [] : [{ personId: scopedPerson, name: 'Current teammate' }],
        });
      return vocabHeld
        ? new Promise<Response>((resolve) => {
            vocabAnswers.push(() => {
              resolve(answer());
            });
          })
        : Promise.resolve(answer());
    }
    if (at.endsWith('/client/list')) {
      const answer = () =>
        json({
          ok: true,
          clients: revoked ? [] : [{ clientId: scopedClient, name: 'Current client' }],
        });
      return vocabHeld
        ? new Promise<Response>((resolve) => {
            vocabAnswers.push(() => {
              resolve(answer());
            });
          })
        : Promise.resolve(answer());
    }
    if (at.endsWith('/task/board')) {
      const body: Record<string, unknown> = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}',
      );
      asked.push(body);
      if (boardOutage) return Promise.resolve(new Response(null, { status: 503 }));
      if (hold !== undefined)
        return new Promise<Response>((resolve) => {
          hold = resolve;
        });
      return Promise.resolve(
        json({
          ok: true,
          tasks: revoked
            ? []
            : tasks.filter((task) => body['mode'] === 'aggregate' || task.board === body['board']),
          changedAt: null,
          viewer: 'different-viewer',
          owed: 0,
        }),
      );
    }
    if (at.endsWith('/task/update')) mutations.push(init?.body);
    return new Promise<Response>(() => {});
  };
  const client = clientFor(fetch);
  return {
    client,
    asked,
    tasks,
    mutations,
    denyPeople: (value = true) => {
      peopleDenied = value;
    },
    outage: (value: boolean, dependency = 'vocabulary') => {
      if (dependency === 'rows') boardOutage = value;
      else {
        outage = value;
        outageDependency = dependency;
      }
    },
    holdVocabulary: () => {
      vocabHeld = true;
    },
    releaseVocabulary: () => {
      vocabHeld = false;
      for (const answer of vocabAnswers.splice(0)) answer();
    },
    invalidate: () =>
      controller?.enqueue(new TextEncoder().encode('event: invalidate\ndata: board\n\n')),
    revoke: () => {
      revoked = true;
    },
    holdNext: () => {
      hold = () => {};
    },
    release: () => {
      const resolve = hold;
      hold = undefined;
      resolve?.(json({ ok: true, tasks, changedAt: null, viewer: 'different-viewer', owed: 0 }));
    },
  };
}
it('aggregate selected and unboarded destinations send distinct checked reads and preserve reader ranks', async () => {
  const api = destinationServer();
  const place = (kind: 'aggregate' | 'selected' | 'unboarded') =>
    encodeBoardAddress({
      ...(kind === 'selected' ? { kind, boardId: boardA } : { kind }),
      person: scopedPerson,
      client: scopedClient,
      filters: [],
      focus: null,
    });
  const view = await mount(panel(api.client, place('aggregate')));
  await tick();
  await tick();
  expect(api.asked.at(-1)).toEqual({
    mode: 'aggregate',
    person: scopedPerson,
    client: scopedClient,
  });
  expect(view.all('[data-row]')).toHaveLength(3);
  expect(view.text()).toContain('Current teammate');
  expect(view.text()).toContain('6 messages waiting on us');
  expect(
    view.all('.cbd__rank').map((rank) => [rank.textContent, rank.getAttribute('title')]),
  ).toEqual([
    ['7', 'reader pool'],
    ['8', 'reader pool'],
    ['9', 'reader pool'],
  ]);
  await view.render(panel(api.client, place('selected')));
  await tick();
  await tick();
  expect(api.asked.at(-1)).toEqual({ board: boardA, person: scopedPerson, client: scopedClient });
  expect(view.all('[data-row]')).toHaveLength(1);
  expect(view.text()).toContain('Scoped work 1');
  await view.render(panel(api.client, place('unboarded')));
  await tick();
  await tick();
  expect(api.asked.at(-1)).toEqual({ board: null, person: scopedPerson, client: scopedClient });
  expect(view.all('[data-row]')).toHaveLength(1);
  expect(view.text()).toContain('Scoped work 3');
});
it('aggregate scope intersects compact filters runtime route focused comment and waiting count', async () => {
  const api = destinationServer();
  api.tasks[1]!.todo.whoseMove = 'Team';
  const address = encodeBoardAddress({
    kind: 'aggregate',
    person: scopedPerson,
    client: scopedClient,
    route: 'Review',
    filters: [
      { kind: 'due', value: 'today' },
      { kind: 'priority', value: 1 },
      { kind: 'tag', value: 'urgent' },
      { kind: 'words', value: 'work' },
      { kind: 'waiting' },
    ],
    focus: 'Scope-3',
  });
  const view = await mount(panel(api.client, address));
  await tick();
  await tick();
  expect(view.all('[data-row]')).toHaveLength(1);
  expect(view.text()).toContain('Scoped work 3');
  expect(view.text()).not.toContain('Scoped work 2');
  expect(view.find('[data-board-waiting-count]')?.textContent).toContain('3 messages');
  expect(view.find('[data-board-reading]')?.textContent).toContain('due today');
  expect(view.find('[data-board-reading]')?.textContent).toContain('Current client');
});
it('permission pending and revoked destinations hide prior rows names counts and ignore held answers', async () => {
  const api = destinationServer();
  const address = encodeBoardAddress({
    kind: 'aggregate',
    person: scopedPerson,
    client: scopedClient,
    filters: [],
    focus: null,
  });
  const view = await mount(panel(api.client, address));
  await tick();
  await tick();
  expect(view.all('[data-row]')).toHaveLength(3);
  api.holdNext();
  await act(async () => {
    api.invalidate();
    await Promise.resolve();
  });
  await tick();
  expect(view.all('[data-row]')).toHaveLength(0);
  expect(view.find('[data-board-reading]')).toBeNull();
  expect(view.find('[data-board-waiting-count]')).toBeNull();
  api.revoke();
  await act(async () => {
    api.invalidate();
    await Promise.resolve();
  });
  await tick();
  await act(async () => {
    api.release();
    await Promise.resolve();
  });
  await tick();
  expect(view.all('[data-row]')).toHaveLength(0);
  expect(view.text()).not.toContain('Current teammate');
  expect(view.text()).not.toContain('Current client');
});
it('malformed duplicate and contradictory destinations never fall back to a wider board', async () => {
  const api = destinationServer();
  const view = await mount(panel(api.client, '/projects/?pool=aggregate&board=none&scope=own'));
  await tick();
  expect(api.asked).toEqual([]);
  for (const query of [
    'board=bad',
    'pool=all&scope=own',
    'pool=aggregate',
    `board=${boardA}&board=none`,
    `pool=aggregate&person=${scopedPerson}&scope=own`,
    'pool=aggregate&scope=own&filters=%5B%7B%22kind%22%3A%22person%22%7D%5D',
  ]) {
    // eslint-disable-next-line no-await-in-loop -- one owner opens invalid places in order.
    await view.render(panel(api.client, `/projects/?${query}`));
    expect(view.text()).toContain('The board scope is invalid.');
    expect(view.all('[data-row]')).toHaveLength(0);
  }
  expect(api.asked).toEqual([]);
});

it('a held authority refresh withdraws private DOM and restores the same board editor query sort and focus', async () => {
  const api = destinationServer();
  const address = encodeBoardAddress({
    kind: 'aggregate',
    person: scopedPerson,
    client: scopedClient,
    filters: [],
    focus: null,
  });
  const view = await mount(panel(api.client, address));
  await tick();
  await tick();
  await view.type('[data-board-search]', 'work');
  await view.click('[data-key="due"] button');
  await act(() => {
    view.find('.cbd__nm')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await view.type('.cbd__rename', 'Unsent edit');
  const boardNode = view.find('[data-board]');
  const editor = view.find('.cbd__rename');
  expect(document.activeElement).toBe(editor);
  api.holdVocabulary();
  await act(() => {
    window.dispatchEvent(new Event('online'));
  });
  await tick();
  expect(view.all('[data-row]')).toHaveLength(0);
  expect(view.text()).not.toContain('Scoped work');
  expect(view.text()).not.toContain('Current teammate');
  expect(view.text()).not.toContain('Current client');
  expect(view.find('[data-board-waiting-count]')).toBeNull();
  await act(async () => {
    api.releaseVocabulary();
    await Promise.resolve();
  });
  await tick();
  expect(view.find('[data-board]')).toBe(boardNode);
  expect(view.find('.cbd__rename')).toBe(editor);
  expect(view.host.querySelector<HTMLInputElement>('.cbd__rename')?.value).toBe('Unsent edit');
  expect(view.host.querySelector<HTMLInputElement>('[data-board-search]')?.value).toBe('work');
  expect(view.find('th[data-key="due"]')?.getAttribute('aria-sort')).toBe('ascending');
  expect(document.activeElement).toBe(editor);
  expect(api.mutations).toEqual([]);
  api.holdVocabulary();
  await act(() => {
    window.dispatchEvent(new Event('online'));
  });
  await tick();
  api.revoke();
  await act(async () => {
    api.releaseVocabulary();
    await Promise.resolve();
  });
  await tick();
  expect(view.find('.cbd__rename')).toBeNull();
  expect(view.all('[data-row]')).toHaveLength(0);
  expect(view.text()).not.toContain('Current client');
});
it('an unknown focused comment key is never named by the admitted board reading', async () => {
  const api = destinationServer();
  const address = encodeBoardAddress({
    kind: 'aggregate',
    person: scopedPerson,
    filters: [],
    focus: 'Private-fabricated-key',
  });
  const view = await mount(panel(api.client, address));
  await tick();
  await tick();
  expect(view.all('[data-row]')).toHaveLength(0);
  expect(view.text()).not.toContain('Private-fabricated-key');
});
it('an admitted target clears ordinary filters focuses its canonical task link and scrolls its row', async () => {
  const api = destinationServer();
  const scroll = vi.fn();
  vi.stubGlobal('HTMLElement', HTMLElement);
  const previous = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    const address =
      encodeBoardAddress({
        kind: 'aggregate',
        person: scopedPerson,
        filters: [],
        focus: null,
        target: 'Scope-3',
      }) + '&q=absent&f=mine&mode=review';
    const view = await mount(panel(api.client, address));
    await tick();
    await tick();
    const row = view.find(`[data-row="${api.tasks[2]!.id}"]`);
    expect(row).not.toBeNull();
    expect(document.activeElement).toBe(row?.querySelector('a.cbd__nm'));
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    expect(view.host.querySelector<HTMLInputElement>('[data-board-search]')?.value).toBe('');
  } finally {
    HTMLElement.prototype.scrollIntoView = previous;
    vi.unstubAllGlobals();
  }
});
it('an out-of-scope target keeps ordinary search and cannot reveal a task', async () => {
  const api = destinationServer();
  api.tasks[2]!.assignee.personId = '99999999-9999-4999-8999-999999999999';
  const address =
    encodeBoardAddress({
      kind: 'aggregate',
      person: scopedPerson,
      filters: [],
      focus: null,
      target: 'Scope-3',
    }) + '&q=absent';
  const view = await mount(panel(api.client, address));
  await tick();
  await tick();
  expect(view.find('.cbd__filters')?.textContent).toContain('absent');
  expect(view.all('[data-row]')).toHaveLength(0);
  expect(view.text()).not.toContain('Scoped work 3');
});

it('a healthy unchanged board stream still refreshes authority vocabulary on its existing floor', async () => {
  vi.useFakeTimers();
  try {
    const api = destinationServer();
    const address = encodeBoardAddress({
      kind: 'aggregate',
      person: scopedPerson,
      client: scopedClient,
      filters: [],
      focus: null,
    });
    const view = await mount(panel(api.client, address));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(view.text()).toContain('Current teammate');
    api.revoke();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(view.text()).not.toContain('Current teammate');
    expect(view.text()).not.toContain('Current client');
    expect(view.all('[data-row]')).toHaveLength(0);
    await view.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it.each(['vocabulary', 'person', 'client', 'rows'])(
  'a transient %s outage withdraws projection but restores the same unsent editor on recovery',
  async (dependency) => {
    const api = destinationServer();
    const address = encodeBoardAddress({
      kind: 'aggregate',
      person: scopedPerson,
      client: scopedClient,
      filters: [],
      focus: null,
    });
    const view = await mount(panel(api.client, address));
    await tick();
    await tick();
    await act(() => {
      view.find('a.cbd__nm')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await view.type('.cbd__rename', 'Kept through outage');
    const editor = view.find('.cbd__rename');
    api.outage(true, dependency);
    await act(async () => {
      api.invalidate();
      await Promise.resolve();
    });
    await tick();
    expect(view.all('[data-row]')).toHaveLength(0);
    expect(view.text()).not.toContain('Current teammate');
    expect(view.text()).not.toContain('Current client');
    expect(view.find('[data-outcome="unavailable"]')).not.toBeNull();
    api.outage(false, dependency);
    await act(async () => {
      api.invalidate();
      await Promise.resolve();
    });
    await tick();
    expect(view.find('.cbd__rename')).toBe(editor);
    expect(view.host.querySelector<HTMLInputElement>('.cbd__rename')?.value).toBe(
      'Kept through outage',
    );
    expect(api.mutations).toEqual([]);
  },
);

it('equivalent uppercase destination identities use canonical reads rows and labels', async () => {
  const api = destinationServer();
  const make = (upper: boolean) =>
    encodeBoardAddress({
      kind: 'selected',
      boardId: upper ? boardA.toUpperCase() : boardA,
      person: upper ? scopedPerson.toUpperCase() : scopedPerson,
      client: upper ? scopedClient.toUpperCase() : scopedClient,
      filters: [],
      focus: null,
    });
  const view = await mount(panel(api.client, make(false)));
  await tick();
  await tick();
  const before = {
    read: api.asked.at(-1),
    rows: view
      .all('[data-row]')
      .map((row) => (row instanceof HTMLElement ? row.dataset['row'] : null)),
    label: view.find('[data-board-reading]')?.textContent,
  };
  await view.render(panel(api.client, make(true)));
  await tick();
  await tick();
  expect({
    read: api.asked.at(-1),
    rows: view
      .all('[data-row]')
      .map((row) => (row instanceof HTMLElement ? row.dataset['row'] : null)),
    label: view.find('[data-board-reading]')?.textContent,
  }).toEqual(before);
});
it('a healthy unchanged stream refreshes tag filtered board membership and waiting count on the existing floor', async () => {
  vi.useFakeTimers();
  try {
    const api = destinationServer();
    const address = encodeBoardAddress({
      kind: 'aggregate',
      client: scopedClient,
      filters: [{ kind: 'tag', value: 'urgent' }],
      focus: null,
    });
    const view = await mount(panel(api.client, address));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(view.all('[data-row]')).toHaveLength(3);
    expect(view.find('[data-board-waiting-count]')?.textContent).toContain('6 messages');
    api.tasks[2]!.todo.tags = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(view.all('[data-row]')).toHaveLength(2);
    expect(view.find('[data-board-waiting-count]')?.textContent).toContain('3 messages');
    await view.unmount();
  } finally {
    vi.useRealTimers();
  }
});
it('a target admitted after the first draw clears ordinary obscuring filters and focuses its existing row', async () => {
  const api = destinationServer();
  api.tasks[2]!.assignee.personId = '99999999-9999-4999-8999-999999999999';
  const address =
    encodeBoardAddress({
      kind: 'aggregate',
      person: scopedPerson,
      filters: [],
      focus: null,
      target: 'Scope-3',
    }) + '&q=absent';
  const view = await mount(panel(api.client, address));
  await tick();
  await tick();
  expect(view.all('[data-row]')).toHaveLength(0);
  api.tasks[2]!.assignee.personId = scopedPerson;
  await act(async () => {
    api.invalidate();
    await Promise.resolve();
  });
  await tick();
  const target = view
    .all('[data-row]')
    .find((row) => (row instanceof HTMLElement ? row.dataset['row'] : null) === api.tasks[2]!.id);
  expect(target).toBeDefined();
  expect(document.activeElement).toBe(target?.querySelector('a.cbd__nm'));
});

it.each(['own', 'client', 'selected', 'unboarded'] as const)(
  'optional denied people vocabulary preserves admitted %s rows and the same unsent editor',
  async (kind) => {
    const api = destinationServer();
    const address = encodeBoardAddress({
      ...(kind === 'selected'
        ? { kind, boardId: boardA }
        : kind === 'unboarded'
          ? { kind }
          : { kind: 'aggregate' as const }),
      ...(kind === 'own' ? { own: true } : kind === 'client' ? { client: scopedClient } : {}),
      filters: [{ kind: 'words', value: 'work' }],
      focus: null,
    });
    const view = await mount(panel(api.client, address));
    await tick();
    await tick();
    const count = kind === 'own' || kind === 'client' ? 3 : 1;
    expect(view.all('[data-row]')).toHaveLength(count);
    await act(() => {
      view.find('a.cbd__nm')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await view.type('.cbd__rename', 'Still permitted unsent edit');
    const editor = view.find('.cbd__rename');
    api.denyPeople();
    await act(async () => {
      api.invalidate();
      await Promise.resolve();
    });
    await tick();
    expect(view.all('[data-row]')).toHaveLength(count);
    expect(view.find('.cbd__rename')).toBe(editor);
    expect(view.host.querySelector<HTMLInputElement>('.cbd__rename')?.value).toBe(
      'Still permitted unsent edit',
    );
    expect(view.find('[data-outcome="denied"]')).toBeNull();
    expect(view.find('button[aria-label^="Change the assignee"]')).toBeNull();
    await view.render(panel(api.client, address + '&q=work'));
    expect(view.all('[data-row]')).toHaveLength(count);
    expect(api.mutations).toEqual([]);
    await view.unmount();
    const cold = await mount(panel(api.client, address));
    await tick();
    await tick();
    expect(cold.all('[data-row]')).toHaveLength(count);
    expect(cold.find('button[aria-label^="Change the assignee"]')).toBeNull();
  },
);
it('an explicit person refusal withdraws the admitted board and clears unsent editor custody', async () => {
  const api = destinationServer();
  const address = encodeBoardAddress({
    kind: 'aggregate',
    person: scopedPerson,
    filters: [],
    focus: null,
  });
  const view = await mount(panel(api.client, address));
  await tick();
  await tick();
  await act(() => {
    view.find('a.cbd__nm')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await view.type('.cbd__rename', 'Must discard on actual refusal');
  const editor = view.find('.cbd__rename');
  api.denyPeople();
  await act(async () => {
    api.invalidate();
    await Promise.resolve();
  });
  await tick();
  expect(view.all('[data-row]')).toHaveLength(0);
  expect(view.find('[data-outcome="denied"]')).not.toBeNull();
  api.denyPeople(false);
  await act(async () => {
    api.invalidate();
    await Promise.resolve();
  });
  await tick();
  expect(view.all('[data-row]')).toHaveLength(3);
  expect(view.find('.cbd__rename')).toBeNull();
  expect(editor?.isConnected).toBe(false);
  expect(api.mutations).toEqual([]);
});
it.each(['initial', 'late'] as const)(
  'a target %s under Work log waits for the visible Board before focus and scroll',
  async (arrival) => {
    const api = destinationServer();
    const scroll = vi.fn();
    const previous = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      if (arrival === 'late') api.holdNext();
      const address = encodeBoardAddress({
        kind: 'aggregate',
        person: scopedPerson,
        filters: [],
        focus: null,
        target: 'Scope-3',
      });
      const view = await mount(panel(api.client, address + '#worklog'));
      await tick();
      await tick();
      if (arrival === 'late') {
        await act(async () => {
          api.release();
          await Promise.resolve();
        });
        await tick();
      }
      expect(view.find('[role="tab"][aria-selected="true"]')?.textContent).toBe('Work log');
      expect(scroll).not.toHaveBeenCalled();
      await act(() => {
        (view.find('[role="tab"][aria-selected="true"]') as HTMLElement | null)?.focus();
      });
      await view.click('[role="tab"]:nth-child(1)');
      await tick();
      const row = view.find(`[data-row="${api.tasks[2]!.id}"]`);
      expect(document.activeElement).toBe(row?.querySelector('a.cbd__nm'));
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      HTMLElement.prototype.scrollIntoView = previous;
    }
  },
);
