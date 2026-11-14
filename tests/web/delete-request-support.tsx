// SPDX-License-Identifier: AGPL-3.0-only
//
// #2359: the real task page over a stub server, for the delete-request cases
// (delete-request.test.tsx, delete-request-page-writes.test.tsx).

import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { ScoresCustodyProvider } from '../../apps/web/src/screens/task/scores-custody-context.tsx';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { json, mount } from './perspective-support.tsx';
import { TASK_ID, tick } from './task-page-stub.tsx';

export const REQUEST = {
  id: '6a1f6d2e-0d7b-4c3e-9a51-2f4b8c9d0e11',
  reason: 'It was a test task.',
  byAgent: true,
  requestedBy: 'Hermes',
  requestedAt: '2026-11-01T00:00:00.000Z',
  expiresAt: '2026-11-08T00:00:00.000Z',
};

export const APPLIED = {
  body: { ok: true, recordId: TASK_ID, revision: 8, detail: {} },
  status: 200,
};

const EXECUTION = {
  ok: true,
  execution: {
    taskId: TASK_ID,
    outcome: 'no-run',
    sourceRevision: 0,
    complete: true,
    next: null,
    runs: [],
    events: [],
  },
};
const SETTLED = { ok: true, recordId: TASK_ID, revision: 5, detail: {} };

/**
 * The real task page over a server that answers `task.read` from a queue (the
 * last answer repeats) and Keep or Confirm with `answer`, counting reads.
 */
export async function livePage(
  reads: readonly unknown[],
  answer: { body: unknown; status: number },
  held: string | null = null,
) {
  const sent: string[] = [];
  let read = 0;
  const waiting: (() => void)[] = [];
  const fetch = ((url: string | URL) => {
    const at = String(url);
    const name = at.slice(at.lastIndexOf('/b/alpha/') + 9).replace('/', '.');
    sent.push(name);
    if (name === 'person.list') return Promise.resolve(json({ ok: true, persons: [] }, 200));
    if (name === 'task.execution') return Promise.resolve(json(EXECUTION, 200));
    if (name === 'task.read') {
      const body = reads[Math.min(read, reads.length - 1)];
      read += 1;
      return Promise.resolve(json({ ok: true, task: body }, 200));
    }
    if (name === held) {
      return new Promise<Response>((resolve) => {
        waiting.push(() => {
          resolve(json(SETTLED, 200));
        });
      });
    }
    return Promise.resolve(json(answer.body, answer.status));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  // The app's own scores owner over this tab's storage, so the page's score fields work as in the app.
  const kept = new Map<string, string>();
  const storage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  };
  const view = await mount(
    <ScoresCustodyProvider client={client} grantKey="alpha:member" storage={storage}>
      <TaskDetailScreen client={client} grantKey="alpha:member" taskKey="Proj-Verity-Pacing" />
    </ScoresCustodyProvider>,
  );
  await tick();
  return { view, sent, reads: () => read, release: () => waiting.splice(0).forEach((go) => go()) };
}

export const buttons = (view: Awaited<ReturnType<typeof mount>>): readonly boolean[] =>
  ['confirm-delete', 'keep'].map(
    (act) =>
      (view.find(`[data-act="${act}"] button`) as HTMLButtonElement | null)?.disabled ?? true,
  );
