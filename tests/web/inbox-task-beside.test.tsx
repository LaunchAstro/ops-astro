// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// CS-7.29 (MP-7-3): a task row on `/inbox/` opens by the gesture law. A plain
// press goes to the task's page, as it always has; Shift opens the task in the
// dock's Task panel beside the panels already open, never solo and never a
// navigation. Where there is no dock, both presses go to the task's page.

import type { ReactElement } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SCREENS } from '../../apps/web/src/screen-registry.tsx';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';
import { json, open } from './mp-2-1-support.tsx';

const entry = (id: string, key: string) => ({
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
});

/** Alpha's inbox, one task owed. Anything else is held open. */
const alpha: typeof globalThis.fetch = (url) => {
  const path = String(url);
  if (path.endsWith('/inbox/read')) {
    return Promise.resolve(json({ ok: true, inbox: [entry('1', 'T-1')] }));
  }
  if (path.endsWith('/inbox/count')) return Promise.resolve(json({ ok: true, owed: 1 }));
  return new Promise<Response>(() => {});
};

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

async function settled(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    // eslint-disable-next-line no-await-in-loop -- each answer lands before the next read
    await settle();
  }
}

async function press(target: Element | null, shiftKey = false): Promise<void> {
  if (target === null) throw new Error('no target');
  await act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }));
  });
  await settled();
}

const openIds = (page: Mounted): (string | undefined)[] =>
  page.all('.dpanel').map((each) => (each as HTMLElement).dataset['panelId']);

const row = (page: Mounted): Element | null => page.find('.content .nt__row');

async function inbox(): Promise<{ page: Mounted; seen: string[] }> {
  const { view, seen } = await open('/inbox/', { fetch: alpha });
  live.push(view);
  await settled();
  await press(view.find('.dock__tab[data-panel="settings"]'));
  return { page: view, seen };
}

describe('CS-7.29 an inbox task row opens by the gesture law', () => {
  it("a plain press goes to the task's page and opens no Task panel", async () => {
    const { page, seen } = await inbox();
    await press(row(page));
    expect(seen.at(-1)).toBe('/task/T-1');
    expect(openIds(page)).not.toContain('task');
  });

  it('a Shift press opens the task in the Task panel beside what is open, in place', async () => {
    const { page, seen } = await inbox();
    const before = seen.length;
    await press(row(page), true);
    expect(openIds(page)).toEqual(['task', 'settings']);
    expect(page.find('[data-panel-id="task"] [data-act="door"]')?.getAttribute('href')).toBe(
      '/task/T-1',
    );
    expect(seen).toHaveLength(before);
  });
});

type Draw = (context: Record<string, unknown>) => ReactElement;

describe('CS-7.29 an inbox task row where there is no dock', () => {
  it("both a plain and a Shift press go to the task's page", async () => {
    const draw = (SCREENS as unknown as Readonly<Record<string, Draw>>)['agency:inbox'];
    const went: string[] = [];
    const client = new OperationsClient({
      origin: 'http://api.test',
      businessKey: 'alpha',
      signedIn: true,
      fetch: alpha,
    });
    const page = await mount(
      draw?.({
        client,
        grantKey: 'alpha:ada',
        params: {},
        navigate: (to: string) => {
          went.push(to);
        },
      }) ?? <p />,
    );
    live.push(page);
    await settled();
    await press(page.find('.nt__row'));
    await press(page.find('.nt__row'), true);
    expect(went).toEqual(['/task/T-1', '/task/T-1']);
  });
});
