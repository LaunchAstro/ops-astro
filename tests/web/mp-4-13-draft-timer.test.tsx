// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Recovered draft timers retain Stop, rounding and Create/retry recovery.
// Fresh timing requires an existing or newly created task.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { typeInto, unmountAll } from './perspective-support.tsx';
import { emptyDraft, keepDraft } from '../../apps/web/src/screens/task/task-draft.ts';
import { ADA, NEW_ID, create, draft, server, store } from './draft-support.tsx';

const START = new Date('2026-10-07T01:00:00Z');
const at = (minutes: number): void => {
  vi.setSystemTime(new Date(START.getTime() + minutes * 60_000));
};
const atSeconds = (seconds: number): void => {
  vi.setSystemTime(new Date(START.getTime() + seconds * 1000));
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

function recovered(timedMs = 0): Storage {
  const storage = store();
  keepDraft(storage, ADA, { ...emptyDraft(null), timerFrom: START.toISOString(), timedMs });
  return storage;
}

describe('MP-4-13 DN-05 the timer works on the draft', () => {
  it('a fresh draft offers selection/Create first and never starts an unfiled clock', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client });
    expect(view.find('[data-draft="timer"]')?.textContent).toBe('Select task to time');
    await view.click('[data-draft="timer"]');
    expect(view.find('[data-draft-timer-running]')).toBeNull();
    expect(sent.filter((one) => ['/time/start', '/time/stop'].includes(one.to))).toEqual([]);
    expect(view.text()).toContain('Create this task first');
  });

  it('legacy Stop adds recovered elapsed time without offering fresh taskless Start', async () => {
    const { view } = await draft({ storage: recovered(8 * 60_000) });
    at(12);
    await view.click('[data-draft="timer"]');
    expect(timed(view)).toBe('Timed on this draft: 20m');
    expect(view.find('[data-draft="timer"]')?.textContent).toBe('Select task to time');
  });

  it('a running timer is kept with the draft across a reload', async () => {
    const storage = recovered();
    const first = await draft({ storage });
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
    const { view } = await draft({ client, storage: recovered() });
    await typeInto(view, '#panel-draft-name', 'Timed brief');
    at(25);
    await create(view);
    expect(sent.map((one) => one.to)).toStrictEqual(['/task/create', '/time/log']);
    expect(sent[1]?.body).toMatchObject({ taskId: NEW_ID, duration: '25m' });
  });

  it('a timer started and stopped at once logs nothing', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client, storage: recovered() });
    await typeInto(view, '#panel-draft-name', 'Quick one');
    await view.click('[data-draft="timer"]');
    await create(view);
    expect(sent.map((one) => one.to)).toStrictEqual(['/task/create']);
  });
});

describe('MP-4-13 DN-05 the draft’s minutes round as the task timer’s do', () => {
  it('recovered stretches add up before rounding, and a part minute rounds up', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client, storage: recovered(9 * 59_000) });
    await typeInto(view, '#panel-draft-name', 'Short stretches');
    atSeconds(59);
    await view.click('[data-draft="timer"]');
    expect(timed(view)).toBe('Timed on this draft: 10m');
    await create(view);
    expect(sent.find((one) => one.to === '/time/log')?.body).toMatchObject({ duration: '10m' });
  });

  it('a draft timed past a day logs a day, as the task timer does', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client, storage: recovered() });
    await typeInto(view, '#panel-draft-name', 'Overnight');
    at(26 * 60);
    await create(view);
    expect(sent.find((one) => one.to === '/time/log')?.body).toMatchObject({ duration: '1440m' });
  });

  it('a Create retried after no answer logs the same minutes once', async () => {
    const { client, sent } = server([], 1);
    const { view } = await draft({ client, storage: recovered() });
    await typeInto(view, '#panel-draft-name', 'Retried');
    at(25);
    await create(view);
    at(40);
    await create(view);
    const creates = sent.filter((one) => one.to === '/task/create');
    expect(creates).toHaveLength(2);
    expect(typeof creates[0]?.body['operationId']).toBe('string');
    expect(creates[1]?.body['operationId'] ?? null).toStrictEqual(
      creates[0]?.body['operationId'] ?? null,
    );
    const logs = sent.filter((one) => one.to === '/time/log');
    expect(logs.map((one) => one.body['duration'])).toStrictEqual(['25m']);
  });
});
