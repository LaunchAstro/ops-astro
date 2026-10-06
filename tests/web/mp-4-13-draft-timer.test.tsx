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

  it('a timer started and stopped at once logs nothing', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client });
    await typeInto(view, '#panel-draft-name', 'Quick one');
    await view.click('[data-draft="timer"]');
    await view.click('[data-draft="timer"]');
    await create(view);
    expect(sent.map((one) => one.to)).toStrictEqual(['/task/create']);
  });
});

describe('MP-4-13 DN-05 the draft’s minutes round as the task timer’s do', () => {
  it('stretches add up before rounding, and a part minute rounds up', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client });
    await typeInto(view, '#panel-draft-name', 'Short stretches');
    for (let stretch = 0; stretch < 10; stretch += 1) {
      atSeconds(stretch * 100);
      // eslint-disable-next-line no-await-in-loop -- one press at a time
      await view.click('[data-draft="timer"]');
      atSeconds(stretch * 100 + 59);
      // eslint-disable-next-line no-await-in-loop -- one press at a time
      await view.click('[data-draft="timer"]');
    }
    expect(timed(view)).toBe('Timed on this draft: 10m');
    await create(view);
    expect(sent.find((one) => one.to === '/time/log')?.body).toMatchObject({ duration: '10m' });
  });

  it('a draft timed past a day logs a day, as the task timer does', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client });
    await typeInto(view, '#panel-draft-name', 'Overnight');
    await view.click('[data-draft="timer"]');
    at(26 * 60);
    await create(view);
    expect(sent.find((one) => one.to === '/time/log')?.body).toMatchObject({ duration: '1440m' });
  });

  it('a Create retried after no answer logs the same minutes once', async () => {
    const { client, sent } = server([], 1);
    const { view } = await draft({ client });
    await typeInto(view, '#panel-draft-name', 'Retried');
    await view.click('[data-draft="timer"]');
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
