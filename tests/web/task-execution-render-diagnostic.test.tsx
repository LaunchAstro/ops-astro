// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it } from 'vitest';
import { A, timerApp, timerWorld } from './task-bound-timer-support.tsx';
import { task, tick } from './task-page-stub.tsx';

function diagnosticWorld() {
  const world = timerWorld();
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const path = String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1');
    requests.push({
      path,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    if (path === '/task/execution')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            execution: {
              outcome: 'no-run',
              runs: [],
              events: [],
              complete: true,
              next: null,
              graph: { plan: 'unbound', sourceRevision: 1, complete: true, nodes: [] },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    return world.fetch(url, init);
  };
  return {
    ...world,
    fetch,
    requests,
    counts: () => ({
      taskReads: requests.filter((one) => one.path === '/task/read').length,
      executionReads: requests.filter((one) => one.path === '/task/execution').length,
      commands: requests.filter((one) => one.body['operationId'] !== undefined).length,
    }),
  };
}

async function drained() {
  await Array.from({ length: 12 }).reduce(async (previous) => {
    await previous;
    await tick();
  }, Promise.resolve());
}

function record(label: string, data: unknown) {
  console.info('[P04-READ-EPOCH]', JSON.stringify({ label, data }));
}

it('page unsent title changes preserve execution reads under the same checked task', async () => {
  const world = diagnosticWorld();
  const { view } = await timerApp(world);
  await drained();
  expect(view.host.querySelector<HTMLElement>('main [data-task]')?.dataset['task']).toBe(A);
  expect(view.host.querySelector<HTMLElement>('main [data-run-progress]')?.dataset['outcome']).toBe(
    'no-run',
  );
  const before = world.counts();
  expect(before.executionReads).toBeGreaterThanOrEqual(2);
  const input = view.host.querySelector<HTMLInputElement>('#task-title')!;
  const steps: ({ value: string } & ReturnType<typeof world.counts>)[] = [];
  const edit = async (value: string) => {
    await view.type('#task-title', value);
    await drained();
    expect(view.find('#task-title')).toBe(input);
    expect(input.value).toBe(value);
    steps.push({ value, ...world.counts() });
  };
  await edit('Alpha work x');
  await edit('Alpha work xy');
  await edit('Alpha work xyz');
  record('page-title', { before, steps });
  expect(world.counts().taskReads).toBe(before.taskReads);
  expect(world.counts().commands).toBe(0);
  expect(view.host.querySelector<HTMLInputElement>('#task-title')?.value).toBe('Alpha work xyz');
  expect(world.counts().executionReads).toBe(before.executionReads);
});

it('page perspective changes preserve execution reads under the same checked task', async () => {
  const world = diagnosticWorld();
  const { view } = await timerApp(world);
  await drained();
  await view.type('#task-title', 'Held unsent perspective title');
  await drained();
  const input = view.host.querySelector<HTMLInputElement>('#task-title')!;
  input.focus();
  input.setSelectionRange(2, 8);
  const before = world.counts();
  expect(before.executionReads).toBeGreaterThanOrEqual(2);
  await view.click('main #perspective-tab-agent');
  await drained();
  const agent = world.counts();
  await view.click('main #perspective-tab-team');
  await drained();
  const team = world.counts();
  record('page-perspective', { before, agent, team });
  expect(view.find('#task-title')).toBe(input);
  expect(input.value).toBe('Held unsent perspective title');
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8]);
  expect(world.counts().taskReads).toBe(before.taskReads);
  expect(world.counts().commands).toBe(0);
  expect(view.find('main #perspective-tab-team')?.getAttribute('aria-selected')).toBe('true');
  expect(world.counts().executionReads).toBe(before.executionReads);
});

it('panel local unsent title edits preserve both mounted readers without task effects', async () => {
  const world = diagnosticWorld();
  const { view } = await timerApp(world);
  await view.click('main [data-panel-door="open"]');
  await drained();
  expect(view.host.querySelector<HTMLElement>('.dpanel [data-task]')?.dataset['task']).toBe(A);
  const before = world.counts();
  expect(before.executionReads).toBeGreaterThanOrEqual(3);
  await view.click('[data-panel-field="name"]');
  await drained();
  const opened = world.counts();
  await view.type('#panel-field-name', 'Alpha unsent local name');
  await drained();
  record('panel-local-title', { before, opened, after: world.counts() });
  expect(world.counts().taskReads).toBe(before.taskReads);
  expect(world.counts().commands).toBe(0);
  expect(view.host.querySelector<HTMLInputElement>('#panel-field-name')?.value).toBe(
    'Alpha unsent local name',
  );
  expect(world.counts().executionReads).toBe(before.executionReads);
  const comment = view.host.querySelector<HTMLTextAreaElement>('#panel-comment-body')!;
  const parentSteps: ({ value: string } & ReturnType<typeof world.counts>)[] = [];
  const edit = async (value: string) => {
    await view.type('#panel-comment-body', value);
    await drained();
    expect(view.find('#panel-comment-body')).toBe(comment);
    expect(comment.value).toBe(value);
    parentSteps.push({ value, ...world.counts() });
  };
  await edit('Held panel a');
  await edit('Held panel ab');
  await edit('Held panel abc');
  comment.focus();
  comment.setSelectionRange(2, 7);
  await view.click('.dpanel #panel-conversation-tab-all');
  await drained();
  await view.click('.dpanel #panel-conversation-tab-internal');
  await drained();
  record('panel-parent-comment', { before, parentSteps, after: world.counts() });
  expect(view.find('#panel-comment-body')).toBe(comment);
  expect(comment.value).toBe('Held panel abc');
  expect(document.activeElement).toBe(comment);
  expect([comment.selectionStart, comment.selectionEnd]).toEqual([2, 7]);
  expect(world.counts().taskReads).toBe(before.taskReads);
  expect(world.counts().commands).toBe(0);
  expect(world.counts().executionReads).toBe(before.executionReads);
});

it('explicit checked reread refreshes execution and task-read denial prevents further dependent reads', async () => {
  const world = diagnosticWorld();
  const { view } = await timerApp(world);
  await drained();
  const before = world.counts();
  expect(before.executionReads).toBeGreaterThanOrEqual(2);
  await view.click('main [data-refresh="task"]');
  await drained();
  const refreshed = world.counts();
  record('checked-refresh', { before, refreshed });
  expect(refreshed.taskReads).toBeGreaterThan(before.taskReads);
  expect(refreshed.executionReads).toBeGreaterThan(before.executionReads);
  expect(
    world.requests
      .filter((one) => one.path === '/task/execution')
      .every((one) => one.body['recordId'] === 'Timer-A' || one.body['recordId'] === A),
  ).toBe(true);
  world.deny();
  await view.click('main [data-refresh="task"]');
  await drained();
  const denied = world.counts();
  record('checked-denial', { refreshed, denied });
  expect(denied.taskReads).toBeGreaterThan(refreshed.taskReads);
  expect(denied.executionReads).toBe(refreshed.executionReads);
  expect(view.find('main [data-task]')).toBeNull();
  expect(view.find('#task-title')).toBeNull();
  expect(world.counts().commands).toBe(0);
  await view.unmount();
  await ownerLateAnswer();
});

const answer = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const execution = (outcome: 'no-run' | 'stale') =>
  answer({
    execution: {
      outcome,
      runs: [],
      events: [],
      complete: true,
      next: null,
      graph: { plan: 'unbound', sourceRevision: 1, complete: true, nodes: [] },
    },
  });
function ownerWorld() {
  const world = timerWorld();
  let newOwner = false;
  const releases: (() => void)[] = [];
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const path = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({ path, body });
    if (path.startsWith('http://gotrue.test/token')) {
      newOwner = true;
      return Promise.resolve(answer({ access_token: 'synthetic-owner-token' }));
    }
    if (path === '/api/session')
      return Promise.resolve(answer({ ok: true, session: 'synthetic-new-owner-session' }));
    if (path.endsWith('/task/execution')) {
      if (newOwner) return Promise.resolve(execution('stale'));
      return new Promise<Response>((resolve) => {
        releases.push(() => resolve(execution('no-run')));
      });
    }
    if (newOwner && path.endsWith('/task/read'))
      return Promise.resolve(
        answer({
          ok: true,
          task: task({
            id: '22222222-2222-4222-8222-222222222222',
            key: 'Timer-A',
            title: 'Current owner task',
            time: { entries: [], running: null, totalMinutes: 0 },
          }),
        }),
      );
    return world.fetch(url, init);
  };
  return { ...world, fetch, releases, sent };
}
async function ownerLateAnswer() {
  const world = ownerWorld();
  const { releases, sent } = world;
  const { view, navigate, storage } = await timerApp(world);
  await drained();
  expect(releases.length).toBeGreaterThanOrEqual(2);
  await view.click('.appbar .who__trigger');
  await view.click('.who__menu button[role="menuitem"]');
  await drained();
  expect(view.find('#signin-email')).not.toBeNull();
  expect(view.find('main [data-task]')).toBeNull();
  await view.choose('#signin-business', 'alpha');
  await view.type('#signin-email', 'next-owner@example.test');
  await view.type('#signin-password', 'synthetic-only');
  await view.click('form.signin__form button[type="submit"]');
  await drained();
  await navigate('/task/Timer-A');
  await drained();
  expect(JSON.parse(storage.getItem('ops-astro.session') ?? '{}').email).toBe(
    'next-owner@example.test',
  );
  expect(view.host.querySelector<HTMLElement>('main [data-task]')?.dataset['task']).toBe(
    '22222222-2222-4222-8222-222222222222',
  );
  expect(view.host.querySelector<HTMLElement>('main [data-run-progress]')?.dataset['outcome']).toBe(
    'stale',
  );
  const before = sent.length;
  await act(() => {
    for (const release of releases) release();
  });
  await drained();
  record('true-owner-late-execution', {
    oldHeld: releases.length,
    requestsBeforeRelease: before,
    requestsAfterRelease: sent.length,
  });
  expect(view.host.querySelector<HTMLElement>('main [data-run-progress]')?.dataset['outcome']).toBe(
    'stale',
  );
  expect(view.text()).not.toContain('Alpha work');
  expect(view.text()).toContain('Current owner task');
  expect(
    sent.filter((one) => one.body['operationId'] !== undefined).map((one) => one.path),
  ).toEqual(['/api/b/alpha/session/end']);
}
