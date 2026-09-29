// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-5 on the task page, the part the comments on the read already carry
// (DT-14, DT-17, DT-21, TT-04): the conversation as three tabs, Internal N,
// Client N and All activity, opening on Internal (R41). A person posts to the
// tab's audience; All shows both and is read-only; Enter sends; the `system`
// kind is never offered. Replies, edits, deletes and the signals are the
// server's next step. The dock task panel places this conversation in MP-4-8.

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { PanelDoor } from '../../apps/web/src/screens/task/Perspectives.tsx';
import { found, task, tick } from './task-page-stub.tsx';
import { json, mount, page, typeInto, unmountAll } from './perspective-support.tsx';
import type { Mounted } from '../surfaces/mount.tsx';

afterEach(unmountAll);

const comment = (id: string, audience: string, at: string, body = `said ${id}`) => ({
  id,
  audience,
  author: 'p-1',
  body,
  comment_type: audience === 'client' ? 'client' : 'note',
  posted_at: at,
  edited_at: null,
  source: 'person',
});

const THREAD = [
  comment('i1', 'internal', '2026-09-20T01:00:00.000Z'),
  comment('c2', 'client', '2026-09-22T01:00:00.000Z', 'the later client message'),
  comment('i2', 'internal', '2026-09-21T01:00:00.000Z'),
  comment('c1', 'client', '2026-09-21T02:00:00.000Z', 'the earlier client message'),
];

const withThread = async (comments: readonly unknown[] = THREAD): Promise<Mounted> =>
  await page('Proj-Verity-Pacing', found({ comments }));

const shown = (view: Mounted): string[] =>
  view
    .all('[role="tabpanel"][id^="conversation-panel-"]:not([hidden]) [data-comment-id]')
    .map((row) => row.getAttribute('data-comment-id') ?? '');

const tabBadge = (view: Mounted, tab: string): string | null =>
  view.find(`#conversation-tab-${tab} .cbadge`)?.textContent ?? null;

/** A server that answers the read and records every comment it is sent. */
function recording(): { readonly client: OperationsClient; readonly sent: unknown[] } {
  const sent: unknown[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (at.endsWith('/task/read')) return Promise.resolve(json({ ok: true, task: task() }));
    if (at.endsWith('/task/comment')) {
      sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      return Promise.resolve(json({ recordId: 'new-comment', revision: 4 }));
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch }),
    sent,
  };
}

const key = async (view: Mounted, selector: string, init: KeyboardEventInit): Promise<void> => {
  const target = view.host.querySelector(selector);
  if (target === null) throw new Error(`nothing matches ${selector}`);
  await act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
};

describe('MP-4-5 tabs and counts', () => {
  it('Internal and Client carry their counts, All activity none, and each shows its own', async () => {
    const view = await withThread();
    expect(view.find('#conversation-tab-internal')?.textContent).toBe('Internal2');
    expect(tabBadge(view, 'internal')).toBe('2');
    expect(tabBadge(view, 'client')).toBe('2');
    expect(view.find('#conversation-tab-all')?.textContent).toBe('All activity');
    await view.click('#conversation-tab-client');
    expect(shown(view)).toStrictEqual(['c1', 'c2']);
    await view.click('#conversation-tab-all');
    expect(shown(view)).toStrictEqual(['i1', 'i2', 'c1', 'c2']);
  });
});

describe('MP-4-5 opens on internal', () => {
  it('the conversation opens on Internal, showing the notes only', async () => {
    const view = await withThread();
    expect(view.find('#conversation-tab-internal')?.getAttribute('aria-selected')).toBe('true');
    expect(shown(view)).toStrictEqual(['i1', 'i2']);
  });
});

describe('MP-4-5 CS-4.32 the tab survives a reread', () => {
  it('a reread keeps the tab the reader chose', async () => {
    const view = await withThread();
    await view.click('#conversation-tab-client');
    await view.click('[data-refresh="task"]');
    await tick();
    expect(view.find('#conversation-tab-client')?.getAttribute('aria-selected')).toBe('true');
    expect(shown(view)).toStrictEqual(['c1', 'c2']);
  });
});

describe('MP-4-5 CS-4.32 the tab survives a post', () => {
  it('a client message posted from Client leaves Client showing', async () => {
    const { client } = recording();
    const view = await mount(
      <TaskDetailScreen client={client} grantKey="alpha:member" taskKey="Proj-Verity-Pacing" />,
    );
    await tick();
    await view.click('#conversation-tab-client');
    await typeInto(view, '#comment-body', 'For the client.');
    await view.click('[data-comment="post"]');
    await tick();
    expect(view.find('#conversation-tab-client')?.getAttribute('aria-selected')).toBe('true');
    expect((view.find('#comment-body') as HTMLTextAreaElement).value).toBe('');
  });
});

describe('MP-4-5 client thread order', () => {
  it('the client thread reads in time order, whatever order it arrived in', async () => {
    const view = await withThread();
    await view.click('#conversation-tab-client');
    const bodies = view
      .all('#conversation-panel-client [data-comment-id] .card__body')
      .map((row) => row.textContent);
    expect(bodies).toStrictEqual(['the earlier client message', 'the later client message']);
  });
});

describe('MP-4-5 CS-4.33 post to the tab’s audience', () => {
  it('Internal posts a note to the business; Client posts a client message to the client', async () => {
    const { client, sent } = recording();
    const view = await mount(
      <TaskDetailScreen client={client} grantKey="alpha:member" taskKey="Proj-Verity-Pacing" />,
    );
    await tick();
    await typeInto(view, '#comment-body', 'For the team.');
    await view.click('[data-comment="post"]');
    await tick();
    await view.click('#conversation-tab-client');
    await typeInto(view, '#comment-body', 'For the client.');
    await view.click('[data-comment="post"]');
    await tick();
    expect(sent).toMatchObject([
      { body: 'For the team.', audience: 'internal', commentType: 'note' },
      { body: 'For the client.', audience: 'client', commentType: 'client' },
    ]);
  });
});

describe('MP-4-5 all is read-only', () => {
  it('on All the composer is disabled and says to pick Internal or Client', async () => {
    const view = await withThread();
    await view.click('#conversation-tab-all');
    expect((view.find('#comment-body') as HTMLTextAreaElement).disabled).toBe(true);
    expect((view.find('[data-comment="post"]') as HTMLButtonElement).disabled).toBe(true);
    expect(view.find('[data-comment="pick"]')?.textContent).toBe(
      'Pick Internal or Client to post, so it is clear who may read it.',
    );
  });
});

describe('MP-4-5 enter sends', () => {
  it('Enter posts what was typed; Shift and Enter does not', async () => {
    const { client, sent } = recording();
    const view = await mount(
      <TaskDetailScreen client={client} grantKey="alpha:member" taskKey="Proj-Verity-Pacing" />,
    );
    await tick();
    await typeInto(view, '#comment-body', 'Sent by Enter.');
    await key(view, '#comment-body', { key: 'Enter', shiftKey: true });
    await tick();
    expect(sent).toHaveLength(0);
    await key(view, '#comment-body', { key: 'Enter' });
    await tick();
    expect(sent).toMatchObject([{ body: 'Sent by Enter.', audience: 'internal' }]);
  });
});

describe('MP-4-5 task wording', () => {
  it('each empty tab says task, never project', async () => {
    const view = await withThread([]);
    for (const tab of ['internal', 'client', 'all']) {
      // eslint-disable-next-line no-await-in-loop -- one tab at a time
      await view.click(`#conversation-tab-${tab}`);
      const words = view.find(`#conversation-panel-${tab}`)?.textContent ?? '';
      expect(words).toMatch(/task/u);
      expect(words).not.toMatch(/project/iu);
    }
  });
});

describe('MP-4-5 no system kind', () => {
  it('the form offers no kind at all, so system is never one', async () => {
    const view = await withThread();
    for (const tab of ['internal', 'client', 'all']) {
      // eslint-disable-next-line no-await-in-loop -- one tab at a time
      await view.click(`#conversation-tab-${tab}`);
      expect(view.find('#task-comment option[value="system"]')).toBeNull();
      expect(view.find('#comment-kind')).toBeNull();
    }
  });
});

describe('MP-4-5 reply door placed', () => {
  it('the conversation has its door into the panel, on the same tab', async () => {
    const opened: PanelDoor[] = [];
    const view = await mount(
      <TaskDetailScreen
        client={recording().client}
        grantKey="alpha:member"
        taskKey="Proj-Verity-Pacing"
        onOpenPanel={(door) => opened.push(door)}
      />,
    );
    await tick();
    expect(view.find('[data-comments="section"] [data-panel-door="reply"]')?.textContent).toBe(
      'Reply in the task panel',
    );
    await view.click('[data-comments="section"] [data-panel-door="reply"]');
    expect(opened).toStrictEqual(['reply']);
  });
});
