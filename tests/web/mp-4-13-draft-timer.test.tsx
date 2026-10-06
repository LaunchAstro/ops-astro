// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-13 DN-05: the timer works on the draft. Start and Stop time the draft,
// a running timer is kept with the draft across a reload, and Create stops it
// and logs the timed minutes on the new task through `time.log`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { typeInto, unmountAll } from './perspective-support.tsx';
import { create, draft, server, store } from './draft-support.tsx';

const START = new Date('2026-10-07T01:00:00Z');
const at = (minutes: number): void => {
  vi.setSystemTime(new Date(START.getTime() + minutes * 60_000));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
});

afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

const timed = (view: Awaited<ReturnType<typeof draft>>['view']): string | null =>
  view.find('[data-draft-timer]')?.textContent ?? null;

describe('MP-4-13 DN-05 the timer works on the draft', () => {
  it('Start times the draft and Stop adds the minutes to it', async () => {
    const { view } = await draft();
    await view.click('[data-draft="timer"]');
    expect(view.find('[data-draft="timer"]')?.textContent).toBe('Stop timer');
    at(12);
    await view.click('[data-draft="timer"]');
    expect(view.find('[data-draft="timer"]')?.textContent).toBe('Start timer');
    expect(timed(view)).toBe('Timed on this draft: 12m');
    await view.click('[data-draft="timer"]');
    at(20);
    await view.click('[data-draft="timer"]');
    expect(timed(view)).toBe('Timed on this draft: 20m');
  });

  it('a running timer is kept with the draft across a reload', async () => {
    const storage = store();
    const first = await draft({ storage });
    await first.view.click('[data-draft="timer"]');
    await first.view.unmount();
    at(5);
    const { view } = await draft({ storage });
    expect(view.find('[data-draft="timer"]')?.textContent).toBe('Stop timer');
    at(9);
    await view.click('[data-draft="timer"]');
    expect(timed(view)).toBe('Timed on this draft: 9m');
  });
});

describe('MP-4-13 DN-05 Create logs the draft’s timed minutes', () => {
  it('Create stops a running timer and logs its minutes on the new task', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client });
    await typeInto(view, '#panel-draft-name', 'Timed brief');
    await view.click('[data-draft="timer"]');
    at(25);
    await create(view);
    expect(sent.map((one) => one.to)).toStrictEqual(['/task/create', '/time/log']);
    expect(sent[1]?.body).toMatchObject({ duration: '25m' });
  });

  it('a timer started and stopped inside a minute logs nothing', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client });
    await typeInto(view, '#panel-draft-name', 'Quick one');
    await view.click('[data-draft="timer"]');
    await view.click('[data-draft="timer"]');
    await create(view);
    expect(sent.map((one) => one.to)).toStrictEqual(['/task/create']);
  });
});
