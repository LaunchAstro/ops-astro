// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-1: the task page's address and header, against a stand-in that answers
// `task.read` the way the API does (`task-page-stub.tsx`). One case per line
// of the ticket's supporting checklist; the pages with no task on them are in
// `mp-4-1-task-absent.test.tsx`. The harness captures (`MP-4-1 visual match`)
// wait on the width-and-theme harness (MP-1-7).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchRoute } from '../../apps/web/src/routes.ts';
import { dataOf, found, page, proposalWith, tick } from './task-page-stub.tsx';

const ADDRESS = '[data-copy="address"]';

const clipboard = (writeText: (text: string) => Promise<void>) => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
};

/** A clipboard that takes the text, and the list of what it took. */
const accepting = (): string[] => {
  const written: string[] = [];
  clipboard((text) => {
    written.push(text);
    return Promise.resolve();
  });
  return written;
};

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('MP-4-1 ruled address', () => {
  it('serves the page at /task/:key and copies that form, never ?task=', async () => {
    expect(matchRoute('/task/Proj-Verity-Pacing')?.id).toBe('agency:task-detail');
    const written = accepting();
    const view = await page('Proj-Verity-Pacing', found());
    await view.click(ADDRESS);
    expect(written).toStrictEqual([`${window.location.origin}/task/Proj-Verity-Pacing`]);
    const hrefs = view.all('header a').map((link) => link.getAttribute('href') ?? '');
    for (const href of [...hrefs, ...written]) expect(href).not.toContain('?task=');
    await view.unmount();
  });
});

describe('MP-4-1 crumb', () => {
  it('reads "Projects →", then the board from the task’s record, then its key and state', async () => {
    const view = await page('Proj-Verity-Pacing', found());
    const parts = view.all('[data-crumb]').map((part) => (part as HTMLElement).dataset['crumb']);
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
    const written = accepting();
    const view = await page('Proj-Verity-Pacing', found());
    vi.useFakeTimers();
    await view.click(ADDRESS);
    expect(written).toStrictEqual([`${window.location.origin}/task/Proj-Verity-Pacing`]);
    expect(dataOf(view, ADDRESS, 'copied')).toBe('yes');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1199);
    });
    expect(dataOf(view, ADDRESS, 'copied')).toBe('yes');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(dataOf(view, ADDRESS, 'copied')).toBe('no');
    await view.unmount();
  });
});

describe('MP-4-1 copy failure said', () => {
  it('shows no tick and says the copy failed when the clipboard refuses', async () => {
    clipboard(() => Promise.reject(new Error('denied')));
    const view = await page('Proj-Verity-Pacing', found());
    await view.click(ADDRESS);
    await tick();
    expect(dataOf(view, ADDRESS, 'copied')).toBe('no');
    expect(view.find('[data-copy="failed"]')?.textContent).toContain('could not be copied');
    await view.unmount();
  });

  it('says so too where there is no clipboard at all', async () => {
    const view = await page('Proj-Verity-Pacing', found());
    await view.click(ADDRESS);
    await tick();
    expect(dataOf(view, ADDRESS, 'copied')).toBe('no');
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

/** Every run line the page draws, as its shape and its words. */
const runLine = async (over: Readonly<Record<string, unknown>>) => {
  const view = await page('Proj-Verity-Pacing', found(over));
  const lines = view.all('[data-run]') as HTMLElement[];
  const shape = lines.map((line) => [line.dataset['run'], line.textContent]);
  await view.unmount();
  return shape;
};

describe('MP-4-1 run line shapes', () => {
  it('a running task says which attempt is running', async () => {
    expect(
      await runLine({ proposals: [proposalWith('handed_back'), proposalWith('dispatched')] }),
    ).toStrictEqual([['running', 'Attempt 2 · running']]);
  });

  it('a finished task says every run has finished', async () => {
    expect(
      await runLine({ proposals: [proposalWith('handed_back', 'abandoned', 'handed_back')] }),
    ).toStrictEqual([['finished', 'Every run on this task has finished.']]);
  });

  it('a task no agent has worked says so', async () => {
    expect(await runLine({ proposals: [] })).toStrictEqual([
      ['none', 'No agent has run this task. It is a person’s work so far.'],
    ]);
    expect(await runLine({ proposals: [proposalWith()] })).toStrictEqual([
      ['none', 'No agent has run this task. It is a person’s work so far.'],
    ]);
  });
});

describe('MP-4-1 visual match', () => {
  it.todo('found, missing and bare states at 1480, 900 and 390, light and dark (MP-1-7 harness)');
});
