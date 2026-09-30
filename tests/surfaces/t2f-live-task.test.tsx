// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// T2f on the page: the open task re-reads itself when its stream says the
// task changed, never underneath an unsaved edit, and re-reads into a denial
// when the server closes the stream. Where the channel is down, a 30-second
// floor re-reads a visible page and never a hidden one.

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { FLOOR_MS, followLive } from '../../apps/web/src/data/live.ts';
import { mount } from './mount.tsx';

const TASK = {
  id: '22222222-2222-4222-8222-222222222222',
  key: 'TSK-2',
  title: 'Before the worker',
  description: null,
  state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  history: [],
  comments: [],
};

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

async function until(say: string, check: () => boolean, deadline: number): Promise<void> {
  if (check()) return;
  if (Date.now() > deadline) throw new Error(`never happened: ${say}`);
  await act(async () => {
    await pause();
  });
  return until(say, check, deadline);
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A task read and a live stream the case writes events into. */
function server() {
  const task = { ...TASK };
  const reads: number[] = [];
  const joins: string[] = [];
  let denied = false;
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();

  const fetch = (async (url: string | URL) => {
    const at = String(url);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.includes('/live/task/')) {
      joins.push(at);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    if (at.endsWith('/task/read')) {
      reads.push(Date.now());
      await pause();
      if (denied) {
        return json(
          { refused: true, code: 'NOT_FOUND', names: [], fixes: ['Check the task.'] },
          404,
        );
      }
      return json({ ok: true, task: { ...task } });
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    task,
    reads,
    joins,
    send: (event: string) =>
      stream?.enqueue(encoder.encode(`event: ${event}\ndata: ${TASK.id}\n\n`)),
    close: () => stream?.close(),
    deny: () => {
      denied = true;
    },
  };
}

const client = (fetch: typeof globalThis.fetch): OperationsClient =>
  new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });

const valueOf = (host: HTMLElement, selector: string): string =>
  (host.querySelector(selector) as HTMLInputElement | null)?.value ?? '';

describe('T2f the live task page', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('event_visible_under_2s (page): an invalidation re-reads the open task page with no refresh', async () => {
    const api = server();
    const view = await mount(
      <TaskDetailScreen client={client(api.fetch)} grantKey="alpha:mia" taskKey={TASK.id} />,
    );
    await until(
      'the task and the stream',
      () => api.joins.length === 1 && view.find('#task-title') !== null,
      Date.now() + 2_000,
    );
    expect(api.joins[0]).toBe(`/api/b/alpha/live/task/${TASK.id}`);

    api.task.title = 'Picked up by the worker';
    const sent = Date.now();
    await act(async () => {
      api.send('invalidate');
      await pause();
    });
    await until(
      'the new title',
      () => valueOf(view.host, '#task-title') === api.task.title,
      sent + 2_000,
    );
    expect(Date.now() - sent).toBeLessThan(2_000);
    await view.unmount();
  });

  it('T2f draft kept: an invalidation during an unsaved edit never discards the draft', async () => {
    const api = server();
    const view = await mount(
      <TaskDetailScreen client={client(api.fetch)} grantKey="alpha:mia" taskKey={TASK.id} />,
    );
    await until(
      'the task and the stream',
      () => api.joins.length === 1 && view.find('#task-title') !== null,
      Date.now() + 2_000,
    );

    await view.type('#task-title', 'My unsaved title');
    api.task.title = 'Somebody else moved it';
    await act(async () => {
      api.send('invalidate');
      await pause();
      await pause();
    });
    expect(valueOf(view.host, '#task-title')).toBe('My unsaved title');
    expect(api.reads).toHaveLength(1);

    // Resolved by the person, the held invalidation reads once.
    await view.click('[data-draft-resolve="discard"]');
    await until(
      'the held re-read',
      () => valueOf(view.host, '#task-title') === api.task.title,
      Date.now() + 2_000,
    );
    await view.unmount();
  });

  it('T2f revoked: a closed stream re-reads, and the refusal shows nothing fetched earlier', async () => {
    const api = server();
    const view = await mount(
      <TaskDetailScreen client={client(api.fetch)} grantKey="alpha:mia" taskKey={TASK.id} />,
    );
    await until(
      'the task and the stream',
      () => api.joins.length === 1 && view.find('#task-title') !== null,
      Date.now() + 2_000,
    );
    expect(valueOf(view.host, '#task-title')).toBe(TASK.title);

    api.deny();
    await act(async () => {
      api.send('closed');
      api.close();
      await pause();
    });
    await until('the denial', () => view.find('#task-title') === null, Date.now() + 2_000);
    expect(view.text()).not.toContain(TASK.title);
    await view.unmount();
  });

  it('a closed stream clears a revoked task despite an unsaved draft', async () => {
    const api = server();
    const view = await mount(
      <TaskDetailScreen client={client(api.fetch)} grantKey="alpha:mia" taskKey={TASK.id} />,
    );
    await until(
      'the task and the stream',
      () => api.joins.length === 1 && view.find('#task-title') !== null,
      Date.now() + 2_000,
    );

    await view.type('#task-title', 'Private unsaved title');
    api.deny();
    await act(async () => {
      api.send('closed');
      api.close();
      await pause();
    });
    await until(
      'the denial after close',
      () => view.find('#task-title') === null,
      Date.now() + 2_000,
    );
    expect(view.text()).not.toContain(TASK.title);
    await view.unmount();
  });
});

describe('T2f floor', () => {
  it('re-reads a visible page every 30 seconds while its channel is down, and never a hidden one', async () => {
    vi.useFakeTimers();
    let visible = true;
    const changes: number[] = [];
    const stop = followLive(
      () => Promise.resolve(null),
      () => changes.push(Date.now()),
      { visible: () => visible },
    );
    await vi.advanceTimersByTimeAsync(FLOOR_MS - 1);
    expect(changes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(changes).toHaveLength(1);
    visible = false;
    await vi.advanceTimersByTimeAsync(FLOOR_MS * 3);
    expect(changes).toHaveLength(1);
    stop();
    vi.useRealTimers();
    expect(FLOOR_MS).toBe(30_000);
  });

  it('a live stream does not reread a hidden page', async () => {
    let visible = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const changes: number[] = [];
    const stop = followLive(
      () => Promise.resolve(body),
      () => changes.push(Date.now()),
      { visible: () => visible },
    );
    await pause();
    await act(async () => {
      controller?.enqueue(new TextEncoder().encode(`event: invalidate\ndata: ${TASK.id}\n\n`));
      await pause();
    });
    expect(changes).toHaveLength(0);
    visible = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(changes).toHaveLength(1);
    stop();
  });
});
