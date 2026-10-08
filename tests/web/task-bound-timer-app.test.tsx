// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { A, B, START, timerApp, timerWorld } from './task-bound-timer-support.tsx';
import { tick } from './task-page-stub.tsx';

it('page Start retains A across an idle B read and strip Stop files exactly one A entry', async () => {
  const world = timerWorld();
  const { view, navigate } = await timerApp(world);
  await view.click('[data-time-log-section] [data-timer]');
  await tick();
  expect(view.find('[data-task-timer-strip]')?.textContent).toContain('Alpha work');
  expect((view.find('[data-task-timer-elapsed]') as HTMLElement | null)?.dataset['startedAt']).toBe(
    START,
  );
  await navigate('/task/Timer-B');
  expect((view.find('main [data-task]') as HTMLElement | null)?.dataset['task']).toBe(B);
  expect(view.find('[data-task-timer-strip]')?.textContent).toContain('Alpha work');
  await view.click('[data-task-timer-strip] button[data-timer]');
  await tick();
  expect(world.writes().map((one) => [one.path, one.body['taskId']])).toEqual([
    ['/time/start', A],
    ['/time/stop', A],
  ]);
  expect(world.finished).toEqual([A]);
});

it('panel close retains the unknown stop after unmount and Retry uses its original envelope', async () => {
  const world = timerWorld();
  const { view } = await timerApp(world);
  await view.click('[data-time-log-section] [data-timer]');
  await view.click('main [data-panel-door="open"]');
  await tick();
  world.loseStop();
  await view.click('.dpanel[data-panel-id="task"] [data-act="close"]');
  await tick();
  expect(view.find('[data-task-panel]')).toBeNull();
  expect(view.find('[data-task-timer-notice]')?.textContent).toContain('lost stop answer');
  const stop = world.writes().find((one) => one.path === '/time/stop');
  await view.click('[data-task-timer-retry]');
  await tick();
  expect(
    world
      .writes()
      .filter((one) => one.path === '/time/stop')
      .map((one) => one.body),
  ).toEqual([stop?.body, stop?.body]);
  expect(world.finished).toEqual([A]);
});

it('closing panel B cannot stop the binding on A', async () => {
  const world = timerWorld();
  const { view, navigate } = await timerApp(world);
  await view.click('[data-time-log-section] [data-timer]');
  await navigate('/task/Timer-B');
  await view.click('main [data-panel-door="open"]');
  await tick();
  await view.click('.dpanel[data-panel-id="task"] [data-act="close"]');
  await tick();
  expect(world.writes().map((one) => one.path)).toEqual(['/time/start']);
  expect(view.find('[data-task-timer-strip]')?.textContent).toContain('Alpha work');
});

it('an unbound strip obtains selection and never creates a taskless timer', async () => {
  const world = timerWorld();
  const { view } = await timerApp(world, '/projects/');
  await view.click('.appbar__timer');
  expect(view.find('[role="dialog"][aria-label="Search"]')).not.toBeNull();
  expect(world.writes()).toEqual([]);
});

it('a lost Start answer blocks a second task until the original Start is retried', async () => {
  const world = timerWorld();
  const { view, navigate } = await timerApp(world);
  world.loseStart();
  await view.click('[data-time-log-section] [data-timer]');
  await tick();
  await navigate('/task/Timer-B');
  expect(view.find('[data-time-log-section] [data-timer]')?.hasAttribute('disabled')).toBe(true);
  await view.click('[data-task-timer-retry]');
  await tick();
  expect(world.writes().map((one) => one.body)).toEqual([
    world.writes()[0]?.body,
    world.writes()[0]?.body,
  ]);
  expect(view.find('[data-task-timer-strip]')?.textContent).toContain('Alpha work');
});

it('board Start binds the canonical row UUID and survives an idle task page', async () => {
  const world = timerWorld();
  const { view, navigate } = await timerApp(world, '/projects/');
  await view.click('[data-route="timer"]');
  await tick();
  expect(view.find('[data-task-timer-strip]')?.textContent).toContain('Alpha work');
  await navigate('/task/Timer-B');
  await view.click('[data-task-timer-strip] button[data-timer]');
  await tick();
  expect(world.writes().map((one) => [one.path, one.body['taskId']])).toEqual([
    ['/time/start', A],
    ['/time/stop', A],
  ]);
});

it('fresh draft timing opens the existing selection door and creates no clock or placeholder task', async () => {
  const world = timerWorld();
  const { view } = await timerApp(world, '/projects/');
  await view.click('[data-new-task]');
  await tick();
  await view.click('[data-draft="timer"]');
  expect(view.find('[role="dialog"][aria-label="Search"]')).not.toBeNull();
  expect(world.writes()).toEqual([]);
  expect(world.sent.filter((one) => one.path === '/task/create')).toEqual([]);
});

it('strip elapsed advances from the server timestamp and task-read denial removes labels while Stop stays scoped', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date(START));
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const world = timerWorld();
  const { view, navigate } = await timerApp(world);
  await view.click('[data-time-log-section] [data-timer]');
  await tick();
  const elapsed = view.find('[data-task-timer-elapsed]')?.textContent;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(view.find('[data-task-timer-elapsed]')?.textContent).not.toBe(elapsed);
  world.deny();
  await navigate('/projects/');
  await navigate('/task/Timer-A');
  expect(view.find('[data-task-timer-strip]')?.textContent).not.toContain('Alpha work');
  expect(view.find('[data-task-timer-strip]')?.textContent).toContain('Task unavailable');
  await view.click('[data-task-timer-strip] button[data-timer]');
  await tick();
  expect(world.writes().map((one) => one.body['taskId'])).toEqual([A, A]);
});

for (const inPanel of [false, true]) {
  it(`strip Stop keeps unsent ${inPanel ? 'panel' : 'page'} time text and caret during its reread`, async () => {
    const world = timerWorld();
    let hold = false;
    const releases: (() => void)[] = [];
    const fetch: typeof globalThis.fetch = (url, init) => {
      const answer = world.fetch(url, init);
      if (!hold || !String(url).endsWith('/task/read')) return answer;
      return new Promise<Response>((resolve) => {
        releases.push(() => {
          void answer.then(resolve);
        });
      });
    };
    const { view } = await timerApp({ ...world, fetch });
    await view.click('[data-time-log-section] [data-timer]');
    await tick();
    if (inPanel) {
      await view.click('main [data-panel-door="open"]');
      await tick();
    }
    if (inPanel) await view.type('#panel-comment-body', 'Private unsent comment');
    const comment = view.find('#panel-comment-body') as HTMLTextAreaElement | null;
    const field = `${inPanel ? '[data-task-panel]' : 'main [data-task]'} [data-time-log]`;
    await view.type(field, '25m private unsent work');
    const input = view.host.querySelector<HTMLInputElement>(field)!;
    input.focus();
    input.setSelectionRange(4, 11);
    hold = true;
    await view.click('[data-task-timer-strip] [data-timer]');
    await tick();
    expect(releases.length).toBeGreaterThan(0);
    expect(view.host.querySelector(field)).toBe(input);
    expect(input.value).toBe('25m private unsent work');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([4, 11]);
    await act(() => {
      for (const release of releases) release();
    });
    expect(view.host.querySelector(field)).toBe(input);
    expect(input.value).toBe('25m private unsent work');
    if (inPanel) {
      expect(view.find('#panel-comment-body')).toBe(comment);
      expect(comment?.value).toBe('Private unsent comment');
    }
  });
}
