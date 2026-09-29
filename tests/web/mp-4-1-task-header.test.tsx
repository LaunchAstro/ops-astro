// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-1: the task page's address and header, against a stand-in that answers
// `task.read` the way the API does. One case per line of the ticket's
// supporting checklist. The harness captures (`MP-4-1 visual match`) wait on
// the width-and-theme harness (MP-1-7).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SCREENS } from '../../apps/web/src/screen-registry.tsx';
import { matchRoute, pathTo } from '../../apps/web/src/routes.ts';
import { mount } from '../surfaces/mount.tsx';

const TASK_ID = '33333333-3333-4333-8333-333333333333';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const NOT_FOUND = {
  refused: true,
  code: 'NOT_FOUND',
  names: ['task'],
  fixes: ['check the address'],
};

const attempt = (state: string) => ({
  id: `r-${state}-${Math.random()}`,
  state: 'held',
  heldMinor: 100,
  actualMinor: null,
  classifiedCause: null,
  leaseId: null,
  lease: null,
  attempt: { id: `a-${Math.random()}`, state, dispatchMarker: false, observed: false },
});

const proposalWith = (...states: readonly string[]) => ({
  lineageId: `l-${Math.random()}`,
  state: 'approved',
  versions: [],
  decisions: [],
  reservations: states.map(attempt),
});

const task = (over: Readonly<Record<string, unknown>> = {}) => ({
  id: TASK_ID,
  key: 'Proj-Verity-Pacing',
  title: 'Budget pacing fix',
  description: null,
  state: { id: 's1', key: 'awaiting', label: 'Awaiting approval', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 4,
  history: [],
  comments: [],
  proposals: [],
  capCurrency: null,
  rank: { number: 4, score: 504, calc: 'impact 7 × confidence 9 × ease 8 = 504 · derived' },
  adHoc: false,
  clientAccess: false,
  board: { readable: true, title: 'Website Projects' },
  ...over,
});

/** `task.read` answers whatever is queued for the key it is asked about. */
function server(answers: Readonly<Record<string, { body: unknown; status?: number }>>) {
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) {
      const asked = String(
        (JSON.parse(String(init?.body ?? '{}')) as { recordId?: unknown }).recordId,
      );
      const answer = answers[asked];
      if (answer === undefined) throw new Error(`no answer queued for ${asked}`);
      return json(answer.body, answer.status ?? 200);
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;
  return new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch });
}

const page = async (taskKey: string, answers: Parameters<typeof server>[0]) => {
  const view = await mount(
    <TaskDetailScreen client={server(answers)} grantKey="alpha:member" taskKey={taskKey} />,
  );
  await tick();
  return view;
};

const found = (over: Readonly<Record<string, unknown>> = {}) => ({
  'Proj-Verity-Pacing': { body: { ok: true, task: task(over) } },
});

const clipboard = (writeText: (text: string) => Promise<void>) => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
};

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('MP-4-1 ruled address', () => {
  it('serves the page at /task/:key and copies that form, never ?task=', async () => {
    expect(matchRoute('/task/Proj-Verity-Pacing')?.id).toBe('agency:task-detail');
    const written: string[] = [];
    clipboard(async (text) => {
      written.push(text);
    });
    const view = await page('Proj-Verity-Pacing', found());
    await view.click('[data-copy="address"]');
    expect(written).toStrictEqual([`${window.location.origin}/task/Proj-Verity-Pacing`]);
    const hrefs = view.all('header a').map((link) => link.getAttribute('href') ?? '');
    for (const href of [...hrefs, ...written]) expect(href).not.toContain('?task=');
    await view.unmount();
  });
});

describe('MP-4-1 crumb', () => {
  it('reads "Projects →", then the board from the task’s record, then its key and state', async () => {
    const view = await page('Proj-Verity-Pacing', found());
    const parts = view.all('[data-crumb]').map((part) => part.getAttribute('data-crumb'));
    expect(parts).toStrictEqual(['projects', 'board', 'key', 'state']);
    expect(view.find('[data-crumb="projects"]')?.textContent).toBe('Projects →');
    expect(view.find('[data-crumb="board"]')?.textContent).toBe('Website Projects');
    expect(view.find('[data-crumb="key"]')?.textContent).toBe('Proj-Verity-Pacing');
    expect(view.find('[data-crumb="state"]')?.textContent).toContain('Awaiting approval');
    await view.unmount();
  });

  it('says a task is on no board, and withholds a board the reader may not open', async () => {
    const none = await page('Proj-Verity-Pacing', found({ board: null }));
    expect(none.find('[data-crumb="board"]')?.textContent).toBe('No board');
    await none.unmount();
    const withheld = await page('Proj-Verity-Pacing', found({ board: { readable: false } }));
    expect(withheld.find('[data-crumb="board"]')?.textContent).toBe('A board you cannot open');
    await withheld.unmount();
  });

  it.todo('reads the category after the board (LEANS-ON: no section or category is named on main)');
});

describe('MP-4-1 copy address tick', () => {
  it('writes the canonical address and shows the tick for 1.2 s', async () => {
    const written: string[] = [];
    clipboard(async (text) => {
      written.push(text);
    });
    const view = await page('Proj-Verity-Pacing', found());
    vi.useFakeTimers();
    await view.click('[data-copy="address"]');
    expect(written).toStrictEqual([`${window.location.origin}/task/Proj-Verity-Pacing`]);
    expect(view.find('[data-copy="address"]')?.getAttribute('data-copied')).toBe('yes');
    await act(async () => {
      vi.advanceTimersByTime(1199);
    });
    expect(view.find('[data-copy="address"]')?.getAttribute('data-copied')).toBe('yes');
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(view.find('[data-copy="address"]')?.getAttribute('data-copied')).toBe('no');
    await view.unmount();
  });
});

describe('MP-4-1 copy failure said', () => {
  it('shows no tick and says the copy failed when the clipboard refuses', async () => {
    clipboard(async () => {
      throw new Error('denied');
    });
    const view = await page('Proj-Verity-Pacing', found());
    await view.click('[data-copy="address"]');
    await tick();
    expect(view.find('[data-copy="address"]')?.getAttribute('data-copied')).toBe('no');
    expect(view.find('[data-copy="failed"]')?.textContent).toContain('could not be copied');
    await view.unmount();
  });

  it('says so too where there is no clipboard at all', async () => {
    const view = await page('Proj-Verity-Pacing', found());
    await view.click('[data-copy="address"]');
    await tick();
    expect(view.find('[data-copy="address"]')?.getAttribute('data-copied')).toBe('no');
    expect(view.find('[data-copy="failed"]')).not.toBeNull();
    await view.unmount();
  });
});

describe('MP-4-1 display title', () => {
  it('is the task’s stored name, in the heading', async () => {
    const view = await page('Proj-Verity-Pacing', found());
    expect(view.find('header .tpr__title')?.textContent).toBe('Budget pacing fix');
    await view.unmount();
  });

  it('wraps rather than clips: the title rule neither truncates nor hides overflow', () => {
    const css = readFileSync(
      join(import.meta.dirname, '../../packages/ui/src/styles/5-task.css'),
      'utf8',
    );
    const rule = /\.tpr__title\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/u);
    expect(rule).not.toMatch(/nowrap|ellipsis|overflow:\s*hidden/u);
  });
});

describe('MP-4-1 run line shapes', () => {
  const runLine = async (over: Readonly<Record<string, unknown>>) => {
    const view = await page('Proj-Verity-Pacing', found(over));
    const lines = view.all('[data-run]');
    const shape = lines.map((line) => [line.getAttribute('data-run'), line.textContent]);
    await view.unmount();
    return shape;
  };

  it('a running task says which attempt is running', async () => {
    expect(
      await runLine({ proposals: [proposalWith('handed_back'), proposalWith('dispatched')] }),
    ).toStrictEqual([['running', 'Attempt 2 · running']]);
  });

  it('a finished task says how many attempts ran and that they are done', async () => {
    expect(
      await runLine({ proposals: [proposalWith('handed_back', 'abandoned', 'handed_back')] }),
    ).toStrictEqual([['finished', 'Attempt 3 · finished']]);
  });

  it('a task no agent has worked says so', async () => {
    expect(await runLine({ proposals: [] })).toStrictEqual([
      ['none', 'No agent has worked on this task'],
    ]);
    expect(await runLine({ proposals: [proposalWith()] })).toStrictEqual([
      ['none', 'No agent has worked on this task'],
    ]);
  });
});

describe('MP-4-1 unknown and missing', () => {
  it('an id with no task quotes it exactly as typed, never in capitals', async () => {
    const view = await page('proj-nope-12', { 'proj-nope-12': { body: NOT_FOUND, status: 404 } });
    const said = view.find('[data-absent="unknown"]')?.textContent ?? '';
    expect(said).toContain('No task is filed under “proj-nope-12”');
    expect(said).not.toContain('PROJ-NOPE-12');
    await view.unmount();
  });

  it('a page with no id says none was named, in other words', async () => {
    const match = matchRoute('/task/');
    expect(match?.id).toBe('agency:task-unnamed');
    const view = await mount(
      SCREENS['agency:task-unnamed']({
        client: server({}),
        grantKey: 'alpha:member',
        params: {},
        notice: null,
        storage: null,
      }),
    );
    const said = view.find('[data-absent="unnamed"]')?.textContent ?? '';
    expect(said).toContain('No task was named');
    const unknown = await page('x', { x: { body: NOT_FOUND, status: 404 } });
    const other = unknown.find('[data-absent="unknown"]')?.textContent ?? '';
    expect(said).not.toBe(other);
    await unknown.unmount();
    await view.unmount();
  });
});

describe('MP-4-1 no fallback task', () => {
  it('an unknown id after a found one shows none of the first task', async () => {
    const answers = {
      ...found(),
      'proj-gone': { body: NOT_FOUND, status: 404 },
    };
    const client = server(answers);
    const view = await mount(
      <TaskDetailScreen client={client} grantKey="alpha:member" taskKey="Proj-Verity-Pacing" />,
    );
    await tick();
    expect(view.text()).toContain('Budget pacing fix');
    await view.render(
      <TaskDetailScreen client={client} grantKey="alpha:member" taskKey="proj-gone" />,
    );
    await tick();
    expect(view.find('[data-absent="unknown"]')).not.toBeNull();
    expect(view.find('[data-task]')).toBeNull();
    expect(view.text()).not.toContain('Budget pacing fix');
    expect(view.text()).not.toContain('Website Projects');
    expect(view.text()).not.toContain('Proj-Verity-Pacing');
    await view.unmount();
  });
});

describe('MP-4-1 CS-4.38 doors', () => {
  it('the crumb goes to the board; the missing states offer it', async () => {
    const board = pathTo('agency:projects-board');
    const view = await page('Proj-Verity-Pacing', found());
    expect(view.find('[data-crumb="projects"]')?.getAttribute('href')).toBe(board);
    await view.unmount();
    const unknown = await page('x', { x: { body: NOT_FOUND, status: 404 } });
    expect(unknown.find('[data-absent] a')?.getAttribute('href')).toBe(board);
    expect(unknown.find('[data-absent] a')?.textContent).toBe('Open the projects board →');
    await unknown.unmount();
    const unnamed = await mount(
      SCREENS['agency:task-unnamed']({
        client: server({}),
        grantKey: 'alpha:member',
        params: {},
        notice: null,
        storage: null,
      }),
    );
    expect(unnamed.find('[data-absent] a')?.getAttribute('href')).toBe(board);
    await unnamed.unmount();
  });

  it('a refusal other than not-found is still the denied state, quoting its code', async () => {
    const view = await page('x', {
      x: { body: { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, status: 403 },
    });
    expect(view.find('[data-outcome="denied"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(view.find('[data-absent="unknown"]')).toBeNull();
    await view.unmount();
  });
});

describe('MP-4-1 visual match', () => {
  it.todo('found, missing and bare states at 1480, 900 and 390, light and dark (MP-1-7 harness)');
});
