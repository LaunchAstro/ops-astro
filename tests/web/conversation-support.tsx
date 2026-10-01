// SPDX-License-Identifier: AGPL-3.0-only
//
// What the MP-4-5 thread suites share: a comment as the read carries it, a
// server whose rereads answer a queue of threads and which records every
// command sent, and the few gestures the thread takes (keys, leaving a box).

import { act } from 'react';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { task, tick } from './task-page-stub.tsx';
import { json, mount } from './perspective-support.tsx';
import type { Mounted } from '../surfaces/mount.tsx';

/** A comment as `task.read` carries it to an internal reader. */
export const comment = (
  id: string,
  audience: string,
  at: string,
  body = `said ${id}`,
  over: Readonly<Record<string, unknown>> = {},
) => ({
  id,
  audience,
  author: 'p-1',
  body,
  comment_type: audience === 'client' ? 'client' : 'note',
  posted_at: at,
  edited_at: null,
  source: 'person',
  parent: null,
  signal: null,
  own: false,
  ...over,
});

export interface Sent {
  readonly to: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * A server whose reads answer the threads queued, one per read (the last
 * repeats), and which records every command it is sent, by its path.
 */
export function conversing(...threads: readonly (readonly unknown[])[]): {
  readonly view: () => Promise<Mounted>;
  readonly sent: Sent[];
} {
  const sent: Sent[] = [];
  let reads = 0;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    // Main's page also reads the queue (T3e2 outages) and the run (T2a), and
    // joins the task's live channel (T2f); none is a command the thread sent.
    if (at.endsWith('/task/queue')) {
      return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
    }
    if (at.endsWith('/task/execution')) return Promise.resolve(json({ ok: false }));
    // The tab's one live stream (C4), unavailable here.
    if (/\/live(\/task\/|\?|$)/u.test(at)) return Promise.resolve(new Response(null, { status: 404 }));
    if (at.endsWith('/task/read')) {
      const comments = threads[Math.min(reads, threads.length - 1)] ?? [];
      reads += 1;
      return Promise.resolve(json({ ok: true, task: task({ comments }) }));
    }
    const to = at.slice(at.lastIndexOf('/task/'));
    sent.push({ to, body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') });
    return Promise.resolve(json({ recordId: 'r', revision: 4 }));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return {
    sent,
    view: async () => {
      const view = await mount(
        <TaskDetailScreen client={client} grantKey="alpha:member" taskKey="Proj-Verity-Pacing" />,
      );
      await tick();
      return view;
    },
  };
}

/** The replies drawn under one message, by id. */
export const repliesUnder = (view: Mounted, id: string): string[] =>
  view
    .all(`[data-comment-id="${id}"] [data-replies] [data-comment-id]`)
    .map((row) => (row as HTMLElement).dataset['commentId'] ?? '');

const on = (view: Mounted, selector: string): Element => {
  const target = view.host.querySelector(selector);
  if (target === null) throw new Error(`nothing matches ${selector}`);
  return target;
};

export const key = async (
  view: Mounted,
  selector: string,
  init: KeyboardEventInit,
): Promise<void> => {
  const target = on(view, selector);
  await act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
};

export const blur = async (view: Mounted, selector: string): Promise<void> => {
  const target = on(view, selector);
  await act(() => {
    target.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
};
