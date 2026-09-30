// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8, the dock task panel's body: what it mounts from the pieces MP-4-3,
// MP-4-5, MP-4-7, MP-4-10 and MP-4-16 built for it. The frame it sits in
// (seat line, float, sheet, back and forward, its one close path) is MP-3-1's;
// the captures wait on MP-1-7; the name, assignee and due edits are
// mp-4-8-panel-fields and mp-4-8-date-picker, and the client and the duplicate
// are later steps of MP-4-8.

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { TaskPanel, type PanelOpening } from '../../apps/web/src/screens/task/Panel.tsx';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, open, press, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

const KEY = 'Proj-Verity-Pacing';

const ignore = (): void => {
  /* The case reads nothing from this call. */
};

const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const change = (minutesAgo: number, operation: string) => ({
  at: at(minutesAgo),
  actorId: 'actor-ada',
  actorName: 'Ada',
  actorKind: 'person',
  operation,
});

interface Sent {
  readonly to: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** A server answering one task, recording every command by its path. */
function serving(over: Readonly<Record<string, unknown>> = {}): {
  readonly client: OperationsClient;
  readonly sent: Sent[];
} {
  const sent: Sent[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const where = String(url);
    if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (where.endsWith('/task/queue')) {
      return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
    }
    if (where.endsWith('/task/execution')) return Promise.resolve(json({ ok: false }));
    if (where.includes('/live/task/')) return Promise.resolve(new Response(null, { status: 404 }));
    if (where.endsWith('/task/read')) return Promise.resolve(json({ ok: true, task: task(over) }));
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ to: where.slice(where.lastIndexOf('/task/')), body });
    return Promise.resolve(json({ recordId: 'r', revision: 5 }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    sent,
  };
}

const panel = async (
  client: OperationsClient,
  opening: Partial<PanelOpening> = {},
  on: { readonly changed?: () => void; readonly close?: () => void } = {},
) => {
  const view = await mount(
    <TaskPanel
      client={client}
      grantKey="alpha:member"
      opening={{ taskKey: KEY, door: 'open', tab: null, ...opening }}
      onChanged={on.changed ?? ignore}
      onClose={on.close ?? ignore}
    />,
  );
  await tick();
  return view;
};

describe('MP-4-8 panel conversation', () => {
  it('the reply door opens the conversation on the tab it was pressed from', async () => {
    const view = await panel(serving().client, { door: 'reply', tab: 'client' });
    expect(view.find('#panel-conversation-tab-client')?.getAttribute('aria-selected')).toBe('true');
    expect(view.find('#panel-comment-body')).not.toBeNull();
    await view.unmount();
  });

  it('beside the task page, no id in the panel repeats one on the page', async () => {
    const { client } = serving();
    const view = await mount(
      <>
        <TaskDetailScreen client={client} grantKey="alpha:member" taskKey={KEY} />
        <TaskPanel
          client={client}
          grantKey="alpha:member"
          opening={{ taskKey: KEY, door: 'reply', tab: 'internal' }}
          onChanged={ignore}
          onClose={ignore}
        />
      </>,
    );
    await tick();
    const ids = [...view.host.querySelectorAll('[id]')].map((element) => element.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toStrictEqual([]);
    await view.unmount();
  });
});

describe('MP-4-8 agent tab placeholder', () => {
  it('the Agent tab is there, not connected, and says why', async () => {
    const view = await panel(serving().client);
    expect(view.find('#panel-perspective-tab-agent')?.textContent).toContain('Agent');
    const pane = view.find('#panel-perspective-panel-agent [data-not-connected="agent"]');
    expect(pane?.textContent).toContain('Not connected yet');
    expect(pane?.textContent).toContain('assistant');
    await view.unmount();
  });
});

describe('MP-4-8 same facts as the task page', () => {
  it('rank, calc line, facts and the perspective counts read the same in both', async () => {
    const { client } = serving({ proposals: [open('a')], adHoc: true });
    const page = await mount(
      <TaskDetailScreen client={client} grantKey="alpha:member" taskKey={KEY} />,
    );
    await tick();
    const pageFacts = page.find('.tpr__facts')?.textContent;
    const pageAgent = page.find('#perspective-tab-agent .cbadge')?.textContent;
    await page.unmount();
    const view = await panel(client);
    expect(pageFacts).toContain('impact 7 × confidence 9 × ease 8 = 504');
    expect(view.find('[data-task-panel] .tpr__facts')?.textContent).toBe(pageFacts);
    expect(view.find('#panel-perspective-tab-agent .cbadge')?.textContent).toBe(pageAgent);
    await view.unmount();
  });
});

describe('MP-4-8 panel mounts the live pieces', () => {
  it('the Ad hoc tick sends its command and asks the page to read again', async () => {
    const { client, sent } = serving();
    let changed = 0;
    const view = await panel(client, {}, { changed: () => (changed += 1) });
    await view.click('[data-task-panel] [data-tick="adhoc"]');
    await tick();
    expect(sent.map((entry) => entry.to)).toStrictEqual(['/task/set_adhoc']);
    expect(changed).toBe(1);
    await view.unmount();
  });

  it('the description and the agent brief are editable fields, not read-only sections', async () => {
    const view = await panel(
      serving({ description: 'Pacing notes', agentBrief: 'Check spend' }).client,
    );
    expect(view.all('[data-task-panel] textarea').length).toBeGreaterThanOrEqual(2);
    await view.unmount();
  });
});

describe('MP-4-8 trail folded', () => {
  it('the panel folds the trail behind Show all N changes and Hide the trail', async () => {
    const history = [
      change(90, 'task.create'),
      change(60, 'task.update'),
      change(30, 'task.assign'),
    ];
    const view = await panel(serving({ history }).client);
    expect(view.find('[data-task-panel] [data-history="trail"]')).toBeNull();
    const fold = '[data-task-panel] [data-history-fold]';
    expect(view.host.querySelector(fold)?.textContent).toBe('Show all 3 changes');
    await view.click(fold);
    expect(view.all('[data-task-panel] [data-history="trail"] .sbact__row')).toHaveLength(3);
    expect(view.host.querySelector(fold)?.textContent).toBe('Hide the trail');
    await view.click(fold);
    expect(view.find('[data-task-panel] [data-history="trail"]')).toBeNull();
    await view.unmount();
  });

  it.todo(
    'MP-4-16 preference saved: the fold is the person’s saved preference (no preference model yet)',
  );
});

describe('MP-4-8 head', () => {
  it('names the task, goes to its own page, and draws New task disabled where no host takes a draft', async () => {
    const view = await panel(serving().client);
    expect(view.find('[data-panel-title]')?.textContent).toBe('Budget pacing fix');
    expect(view.find('[data-panel-head="page"]')?.getAttribute('href')).toBe(`/task/${KEY}`);
    const make = view.find('[data-panel-head="new"]') as HTMLButtonElement | null;
    expect(make?.disabled).toBe(true);
    await view.unmount();
  });
});

describe('MP-4-8 escape closes', () => {
  it('Escape on the panel closes it', async () => {
    let closed = 0;
    const view = await panel(serving().client, {}, { close: () => (closed += 1) });
    await press(view, '[data-task-panel]', 'Escape');
    expect(closed).toBe(1);
    await view.unmount();
  });
});

describe('MP-4-8 escape closes only the control', () => {
  it('Escape in the comment box closes nothing', async () => {
    let closed = 0;
    const view = await panel(
      serving().client,
      { door: 'reply', tab: 'internal' },
      {
        close: () => (closed += 1),
      },
    );
    await press(view, '#panel-comment-body', 'Escape');
    expect(closed).toBe(0);
    await view.unmount();
  });

  it('Escape in the subtask box or the time box closes nothing; on a button it closes', async () => {
    let closed = 0;
    const time = { entries: [], running: null, totalMinutes: 0 };
    const view = await panel(serving({ time }).client, {}, { close: () => (closed += 1) });
    await press(view, '[data-task-panel] [data-step-add]', 'Escape');
    await press(view, '[data-task-panel] [data-time-log]', 'Escape');
    expect(closed).toBe(0);
    await press(view, '[data-task-panel] [data-panel-head="close"]', 'Escape');
    expect(closed).toBe(1);
    await view.unmount();
  });
});

describe('MP-4-8 close uses the frame', () => {
  it.todo('closing goes through MP-3-1’s close and MP-4-6’s stop-and-log (SL06 U08 not on main)');
});

describe('MP-4-8 visual match', () => {
  it.todo('matches the mockup at 1480, 900 and 390, light and dark (MP-1-7 harness)');
});
