// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// review/305-pf-keep round 2: the panel stays mounted under a re-read, so a
// rename opened before a colleague's change is still open after it. The name
// typed there was based on the revision the rename opened at, and is sent at
// that revision, so the colleague's change answers VERSION_STALE rather than
// being overwritten.

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, press, typeInto, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

const ignore = (): void => {
  /* unread */
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
    if (/\/live(\/task\/|\?|$)/u.test(where)) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    // The panel's Project field (SL08) reads the Projects board.
    if (where.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
    if (where.endsWith('/task/read')) {
      reads += 1;
      // A colleague renames the task between the two reads.
      const answer =
        reads === 1
          ? task({ title: 'Ours', revision: 4 })
          : task({ title: "A colleague's name", revision: 5 });
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
    opening={{ taskKey: 'Proj-Verity-Pacing', door: 'open', tab: null }}
    changes={props.changes}
    onChanged={ignore}
    onClose={ignore}
  />
);

describe('review/305-pf-keep round 2: the panel rename under a re-read', () => {
  it('a rename opened before a colleague renamed the task is sent at the revision it opened at', async () => {
    const { client, updates } = serving();
    const view = await mount(<Panel client={client} changes={0} />);
    await tick();
    await view.click('[data-panel-field="name"]');
    await view.render(<Panel client={client} changes={1} />);
    await tick();
    expect((view.find('[data-task]') as HTMLElement | null)?.dataset['revision']).toBe('5');
    await typeInto(view, '#panel-field-name', 'Ours, renamed');
    await press(view, '#panel-field-name', 'Enter');
    await tick();
    expect(updates).toHaveLength(1);
    expect(
      updates[0]?.['expectedRevision'],
      "the rename was sent at the re-read's revision, over the colleague's name",
    ).toBe(4);
  });
});
