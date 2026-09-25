// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Comments on `/task/:key`, against a stand-in that answers the way the API
// does: `task.read` carries the comments, `task.comment` writes one beside the
// task and leaves the task's own revision alone.
//
// Three rules are held here, and each of them is a thing the screen could get
// wrong in a way no type would catch.
//
// **The list is the server's.** A posted comment appears because the screen
// read the task again, not because the screen added it to a list of its own. A
// screen that appends locally shows a comment that may never have been stored,
// which is B7's failure wearing a friendlier face.
//
// **The form is locked for the length of its own request.** A second press
// while the first is in flight is a second comment nobody asked for.
//
// **A refused comment is quoted and then not asked again.** There is no grant
// read in this build, so the screen cannot know before it asks; what it can do
// is ask once, draw the server's own code, and stop offering a control that
// has already been refused for this reader.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const TASK_ID = '22222222-2222-4222-8222-222222222222';

const COMMENT = {
  id: 'c1',
  audience: 'internal',
  author: 'actor-ada',
  body: 'The first note on this one.',
  comment_type: 'note',
  posted_at: '2026-09-23T01:00:00.000Z',
};

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** One task whose comments really are written, read back and counted. */
function server(options: { readonly refuseComment?: boolean } = {}) {
  const task = {
    id: TASK_ID,
    key: 'TSK-9',
    title: 'A task with something to say about it',
    description: null,
    state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 4,
    history: [] as { at: string; actorId: string; operation: string }[],
    comments: [COMMENT] as (typeof COMMENT)[],
  };
  const posted: Record<string, unknown>[] = [];
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;

  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return json({ ok: true, task });
    if (at.endsWith('/task/comment')) {
      posted.push(body);
      const held = gate;
      gate = null;
      await (held ?? Promise.resolve());
      if (options.refuseComment === true) {
        return json(
          {
            refused: true,
            code: 'SCOPE_NOT_GRANTED',
            names: ['task'],
            fixes: ['no live grant covers it', 'ask a holder who may delegate'],
          },
          403,
        );
      }
      task.comments = [
        ...task.comments,
        {
          id: `c${String(task.comments.length + 1)}`,
          audience: String(body['audience']),
          author: 'actor-ada',
          body: String(body['body']),
          comment_type: String(body['commentType'] ?? 'note'),
          posted_at: '2026-09-23T02:00:00.000Z',
        },
      ];
      // The task's own revision is unchanged: a comment is a record beside the
      // task, not an edit to it.
      return json({ recordId: task.id, revision: task.revision, detail: { commentId: 'c-new' } });
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    task,
    posted,
    hold: () => {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release: () => {
      open?.();
    },
  };
}

const client = (fetch: typeof globalThis.fetch): OperationsClient =>
  new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch });

const screen = (fetch: typeof globalThis.fetch) => (
  <TaskDetailScreen client={client(fetch)} grantKey="alpha:ada" taskKey={TASK_ID} />
);

async function typeInto(host: HTMLElement, selector: string, value: string): Promise<void> {
  const field = host.querySelector(selector) as HTMLTextAreaElement | null;
  if (field === null) throw new Error(`nothing matches ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(host: HTMLElement, selector: string, value: string): Promise<void> {
  const field = host.querySelector(selector) as HTMLSelectElement | null;
  if (field === null) throw new Error(`nothing matches ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('comments on the task page', () => {
  it('draws what the read carried, in posted order, with the audience on each', async () => {
    const api = server();
    const page = await mount(screen(api.fetch));
    await tick();

    const rows = page.all('[data-comment-id]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('data-audience')).toBe('internal');
    expect(page.text()).toContain('The first note on this one.');
    await page.unmount();
  });

  it('posts through task.comment and refreshes the list from the read', async () => {
    const api = server();
    const page = await mount(screen(api.fetch));
    await tick();

    await typeInto(page.host, '#comment-body', 'A second note, typed by a person.');
    await choose(page.host, '#comment-audience', 'client');
    await page.click('[data-comment="post"]');
    await tick();

    expect(api.posted).toHaveLength(1);
    expect(api.posted[0]?.['audience']).toBe('client');
    expect(api.posted[0]?.['body']).toBe('A second note, typed by a person.');
    expect(api.posted[0]?.['recordId']).toBe(TASK_ID);
    // The envelope is the wire's, camelCase, and a comment carries the
    // revision it was written against without moving it.
    expect(typeof api.posted[0]?.['operationId']).toBe('string');
    expect(api.posted[0]?.['expectedRevision']).toBe(4);

    const rows = page.all('[data-comment-id]');
    expect(rows).toHaveLength(2);
    expect(page.text()).toContain('A second note, typed by a person.');
    // The box is empty again, because what was in it has been stored.
    expect((page.find('#comment-body') as HTMLTextAreaElement).value).toBe('');
    await page.unmount();
  });

  it('locks the form for the length of its own request', async () => {
    const api = server();
    const page = await mount(screen(api.fetch));
    await tick();

    await typeInto(page.host, '#comment-body', 'Held open on purpose.');
    api.hold();
    await page.click('[data-comment="post"]');
    await act(async () => {
      await pause();
    });

    expect((page.find('[data-comment="post"]') as HTMLButtonElement).disabled).toBe(true);
    expect((page.find('#comment-body') as HTMLTextAreaElement).disabled).toBe(true);
    // A second press while the first is in flight is a second comment.
    await page.click('[data-comment="post"]');
    expect(api.posted).toHaveLength(1);

    await act(async () => {
      api.release();
      await pause();
      await pause();
      await pause();
    });
    expect((page.find('[data-comment="post"]') as HTMLButtonElement).disabled).toBe(false);
    await page.unmount();
  });

  it('quotes a refused comment and stops offering the control to that reader', async () => {
    const api = server({ refuseComment: true });
    const page = await mount(screen(api.fetch));
    await tick();

    await typeInto(page.host, '#comment-body', 'A note mia may not write.');
    await page.click('[data-comment="post"]');
    await tick();

    const refusal = page.find('[data-comment="refusal"]');
    expect(refusal?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect((page.find('[data-comment="post"]') as HTMLButtonElement).disabled).toBe(true);
    expect((page.find('#comment-body') as HTMLTextAreaElement).disabled).toBe(true);
    // The task itself is still drawn, and the comments it carried are still
    // drawn. A refused write is not a failed read.
    expect(page.all('[data-comment-id]')).toHaveLength(1);

    // And nothing asks again. The control is gone from under the person's
    // finger, so a second press cannot send a second refused request.
    await page.click('[data-comment="post"]');
    await tick();
    expect(api.posted).toHaveLength(1);
    await page.unmount();
  });
});
