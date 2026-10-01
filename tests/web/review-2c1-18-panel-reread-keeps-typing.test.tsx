// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-18 red proof: a re-read of the dock task panel wipes what the
// person was typing. TaskPanel (apps/web/src/screens/task/Panel.tsx) draws
// its RecordState without `keep`, so a new `changes` count (a write here or on
// the page) drops the panel body to the loading line and mounts it fresh: the
// unsent comment and the chosen perspective are gone. The task page keeps
// its body under a re-read (TaskDetail.tsx, `keep={held !== null}`). Passes
// once the panel keeps its last answer drawn while it reads again.

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, typeInto, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

const KEY = 'Proj-Verity-Pacing';

const ignore = (): void => {
  /* The case reads nothing from this call. */
};

/** A server answering one task; it counts the task reads. */
function serving(): { readonly client: OperationsClient; readonly reads: { count: number } } {
  const reads = { count: 0 };
  const fetch = ((url: string | URL) => {
    const where = String(url);
    if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (where.endsWith('/task/queue')) {
      return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
    }
    if (where.endsWith('/task/execution')) return Promise.resolve(json({ ok: false }));
    if (/\/live(\/task\/|\?|$)/u.test(where)) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (where.endsWith('/task/read')) {
      reads.count += 1;
      return Promise.resolve(json({ ok: true, task: task() }));
    }
    return Promise.resolve(json({ recordId: 'r', revision: 5 }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    reads,
  };
}

const Panel = (props: { readonly client: OperationsClient; readonly changes: number }) => (
  <TaskPanel
    client={props.client}
    grantKey="alpha:member"
    opening={{ taskKey: KEY, door: 'reply', tab: 'internal' }}
    changes={props.changes}
    onChanged={ignore}
    onClose={ignore}
  />
);

describe('REVIEW-2C1-18 the panel under a re-read', () => {
  it('REVIEW-2C1-18: a new change count re-reads the panel and wipes the unsent comment and the chosen perspective', async () => {
    const { client, reads } = serving();
    const view = await mount(<Panel client={client} changes={0} />);
    await tick();
    await typeInto(view, '#panel-comment-body', 'Half a reply to the client');
    expect((view.find('#panel-comment-body') as HTMLTextAreaElement | null)?.value).toBe(
      'Half a reply to the client',
    );
    await view.click('#panel-perspective-tab-agent');
    expect(view.find('#panel-perspective-tab-agent')?.getAttribute('aria-selected')).toBe('true');
    const before = reads.count;

    await view.render(<Panel client={client} changes={1} />);
    await tick();
    expect(reads.count, 'the new change count did not read the task again').toBe(before + 1);
    expect(
      (view.find('#panel-comment-body') as HTMLTextAreaElement | null)?.value,
      'the re-read wiped the comment being typed in the panel',
    ).toBe('Half a reply to the client');
    expect(
      view.find('#panel-perspective-tab-agent')?.getAttribute('aria-selected'),
      'the re-read put the panel back on the Team perspective',
    ).toBe('true');
  });
});
