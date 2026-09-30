// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1g, the working minimum inside Tasks: the board screen draws the
// caller's inbox and owed count from the same reads the API and the command
// line serve (`inbox.read`, `inbox.count`), and opening an item stamps it seen
// through `inbox.seen` before the task opens. Each case is one checklist line.

import { describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { Inbox } from '../../apps/web/src/views/inbox.tsx';
import type { InboxEntry } from '../../packages/core-wire/src/index.ts';
import { mount, settle } from './mount.tsx';

const entry = (over: Partial<InboxEntry> & Pick<InboxEntry, 'id'>): InboxEntry => ({
  reason: 'mention',
  workState: 'open',
  access: 'readable',
  owed: true,
  counted: true,
  raisedAt: '2026-09-29T00:00:00.000Z',
  closedAt: null,
  seenAt: null,
  lastDelivery: null,
  subjectRecordId: `task-${over.id}`,
  task: { key: `T-${over.id}`, title: `Task ${over.id}` },
  closedBy: null,
  ...over,
});

function server(inbox: readonly InboxEntry[], owed: number) {
  const posted: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const path = String(url);
    posted.push({ path, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    if (path.endsWith('/inbox/read')) return Promise.resolve(Response.json({ ok: true, inbox }));
    if (path.endsWith('/inbox/count')) return Promise.resolve(Response.json({ ok: true, owed }));
    if (path.endsWith('/inbox/seen')) {
      return Promise.resolve(Response.json({ recordId: null, revision: null }));
    }
    return Promise.resolve(Response.json({ ok: true, tasks: [] }));
  }) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, posted };
}

// eslint-disable-next-line max-lines-per-function -- one mounted screen, and the cases that share it
describe('INB-1g the inbox inside Tasks', () => {
  it('INB-1 the inbox lands inside Tasks: the board screen draws the items and the owed count', async () => {
    const api = server([entry({ id: 'a' }), entry({ id: 'b', reason: 'assignment' })], 2);
    const view = await mount(
      <Projects client={api.client} grantKey="alpha:mia" navigate={() => {}} />,
    );
    await settle();
    expect((view.find('[data-inbox-count]') as HTMLElement | null)?.dataset['inboxCount']).toBe(
      '2',
    );
    expect(view.all('[data-inbox-item]')).toHaveLength(2);
    expect(view.text()).toContain('You were mentioned');
    expect(view.text()).toContain('Assigned to you');
    expect(api.posted.map((p) => p.path)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/inbox\/read$/u),
        expect.stringMatching(/\/inbox\/count$/u),
      ]),
    );
    await view.unmount();
  });

  it("INB-1 alert: an entry on a run shows its alert in the task page's words, and no other entry shows one", async () => {
    const api = server(
      [
        entry({
          id: 'run',
          reason: 'waiting_run',
          alert: {
            id: 'alert-1',
            kind: 'awaiting_person',
            waitingReason: 'quarantined',
            raisedAt: '2026-09-29T00:00:00.000Z',
          },
        }),
        entry({ id: 'plain' }),
      ],
      2,
    );
    const view = await mount(<Inbox client={api.client} grantKey="alpha:mia" />);
    await settle();
    expect(view.all('[data-alert]')).toHaveLength(1);
    expect(view.find('[data-alert]')?.textContent).toContain(
      'Waiting on a person. The hold is kept. A person reconciles this attempt.',
    );
    await view.unmount();
  });

  it('INB-1 nothing is shown as delivered when only sent is known: asked, accepted, delivered and seen stay four states', async () => {
    const api = server(
      [
        entry({ id: 'asked', lastDelivery: 'asked' }),
        entry({ id: 'accepted', lastDelivery: 'accepted' }),
        entry({ id: 'delivered', lastDelivery: 'delivered' }),
        entry({ id: 'seen', lastDelivery: 'delivered', seenAt: '2026-09-29T01:00:00.000Z' }),
      ],
      4,
    );
    const view = await mount(<Inbox client={api.client} grantKey="alpha:mia" />);
    await settle();
    const words = (id: string): string => view.find(`[data-inbox-item="${id}"]`)?.textContent ?? '';
    expect(words('asked')).toContain('Asked');
    expect(words('asked')).not.toContain('Delivered');
    expect(words('accepted')).toContain('Accepted, not yet delivered');
    expect(words('accepted')).not.toMatch(/(^|\s)Delivered/u);
    expect(words('delivered')).toContain('Delivered');
    expect(words('delivered')).not.toContain('Seen');
    expect(words('seen')).toContain('Delivered');
    expect(words('seen')).toContain('Seen');
    await view.unmount();
  });

  it('INB-1 a cleared item names who decided', async () => {
    const api = server(
      [
        entry({
          id: 'c',
          reason: 'decision',
          workState: 'cleared',
          counted: false,
          closedByPersonId: 'p-mia',
          closedBy: { personId: 'p-mia', name: 'Mia Member' },
        }),
      ],
      0,
    );
    const view = await mount(<Inbox client={api.client} grantKey="alpha:mia" />);
    await settle();
    expect(view.find('[data-inbox-item="c"]')?.textContent).toContain('Cleared by Mia Member');
    expect((view.find('[data-inbox-count]') as HTMLElement | null)?.dataset['inboxCount']).toBe(
      '0',
    );
    await view.unmount();
  });

  it('INB-1 opening an item stamps it seen and leaves it open and counted', async () => {
    const api = server([entry({ id: 'o' })], 1);
    const went: string[] = [];
    const view = await mount(
      <Inbox client={api.client} grantKey="alpha:mia" go={(href) => went.push(href)} />,
    );
    await settle();
    await view.click('[data-inbox-item="o"] a');
    await settle();
    const stamp = api.posted.find((p) => p.path.endsWith('/inbox/seen'));
    expect(stamp?.body['itemId']).toBe('o');
    expect(typeof stamp?.body['operationId']).toBe('string');
    expect(went).toHaveLength(1);
    expect(went[0]).toMatch(/\/task\/T-o$/u);
    // Nothing on the screen closed it: still waiting and still counted.
    expect((view.find('[data-inbox-item="o"]') as HTMLElement | null)?.dataset['counted']).toBe(
      'true',
    );
    expect(view.find('[data-inbox-item="o"]')?.textContent).toContain('Waiting for you');
    await view.unmount();
  });

  it('INB-1 withheld is not gone: a gone entry is drawn, names no task and links nowhere', async () => {
    const gone: InboxEntry = {
      id: 'g',
      reason: 'mention',
      workState: 'open',
      access: 'gone',
      owed: true,
      counted: false,
      raisedAt: '2026-09-29T00:00:00.000Z',
      closedAt: null,
      seenAt: null,
      lastDelivery: null,
    };
    const api = server([gone], 0);
    const view = await mount(<Inbox client={api.client} grantKey="alpha:mia" />);
    await settle();
    const row = view.find('[data-inbox-item="g"]');
    expect(row?.textContent).toContain('This task is no longer there');
    expect(row?.querySelector('a')).toBeNull();
    await view.unmount();
  });
});
