// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// review/305-pf-keep-1: with `keep`, the panel's description field stays
// mounted under a re-read and still shows the text it was first read with,
// while its save is sent at the re-read's revision. A colleague's change to
// the description is then overwritten without a VERSION_STALE.

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, typeInto, unmountAll } from './perspective-support.tsx';
import { blur, settleWrites } from './writing-support.tsx';

afterEach(unmountAll);

const KEY = 'Proj-Verity-Pacing';
const ignore = (): void => {
  /* unused */
};

function serving() {
  let reads = 0;
  const updates: Record<string, unknown>[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const where = String(url);
    if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (where.endsWith('/task/queue')) {
      return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
    }
    if (where.endsWith('/task/execution')) return Promise.resolve(json({ ok: false }));
    if (/\/live(\/task\/|\?|$)/u.test(where))
      return Promise.resolve(new Response(null, { status: 404 }));
    // The panel's Project field (SL08) reads the Projects board.
    if (where.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
    if (where.endsWith('/task/read')) {
      reads += 1;
      // First read: our text at revision 4. Later reads: a colleague changed it.
      const answer =
        reads === 1
          ? task({ description: 'Ours', revision: 4 })
          : task({ description: "A colleague's text", revision: 5 });
      return Promise.resolve(json({ ok: true, task: answer }));
    }
    if (where.endsWith('/task/update')) {
      updates.push(
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
      );
    }
    return Promise.resolve(json({ recordId: 'r', revision: 6 }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    updates,
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

describe('review/305-pf-keep-1 the panel description under a re-read', () => {
  it('a description save after a colleague changed it is not sent at the new revision over the old text', async () => {
    const { client, updates } = serving();
    const at = 'textarea[data-writing="description"]';
    const view = await mount(<Panel client={client} changes={0} />);
    await tick();
    await view.render(<Panel client={client} changes={1} />);
    await tick();
    const shown = (view.find(`${at}`) as HTMLTextAreaElement | null)?.value;
    const revision = (view.find('[data-task]') as HTMLElement | null)?.dataset['revision'];
    expect(revision).toBe('5');
    await typeInto(view, at, `${shown ?? ''} and mine`);
    await blur(view, at);
    await settleWrites();
    expect(updates).toHaveLength(1);
    const sent = updates[0] as { expectedRevision?: number; fields?: { description?: string } };
    // Honest either way: the field showed the colleague's text, or the save
    // goes at the revision its text was read at (and is refused stale).
    const overwrote = shown === 'Ours' && sent.expectedRevision === 5;
    expect(
      overwrote,
      `field showed "${String(shown)}" and the save went at revision ${String(sent.expectedRevision)}: the colleague's change is overwritten`,
    ).toBe(false);
  });
});
