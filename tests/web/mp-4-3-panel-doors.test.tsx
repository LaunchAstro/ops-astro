// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-3: the Team and Agent counts after a write, and the task page's doors
// into the dock task panel (TT-06), which MP-4-8 builds and wires. The harness
// captures (`MP-4-3 visual match`) wait on MP-1-7.

import { afterEach, describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { PanelDoorButton, type PanelDoor } from '../../apps/web/src/screens/task/Perspectives.tsx';
import { found, server, task, tick } from './task-page-stub.tsx';
import { badge, json, mount, open, page, typeInto, unmountAll } from './perspective-support.tsx';

// A test that fails before its own unmount would leave its page mounted.
afterEach(unmountAll);

/** A server whose read answers the task as it stands after each write. */
function changing(
  first: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
) {
  let current = task(first);
  const fetch = ((url: string | URL) => {
    const at = String(url);
    if (at.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (at.endsWith('/task/read')) return Promise.resolve(json({ ok: true, task: current }));
    if (at.endsWith('/task/complete') || at.endsWith('/task/comment')) {
      current = task({ ...after, revision: 5 });
      return Promise.resolve(json({ recordId: current.id, revision: 5 }));
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;
  return new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch });
}

describe('MP-4-3 counts update at once after a status or message change', () => {
  it('a status change rereads the task: the Agent count and whose move follow it', async () => {
    const view = await mount(
      <TaskDetailScreen
        client={changing(
          { proposals: [open('a')] },
          { proposals: [], completedAt: '2026-09-29T00:00:00.000Z' },
        )}
        grantKey="alpha:member"
        taskKey="Proj-Verity-Pacing"
      />,
    );
    await tick();
    expect(badge(view, 'agent')).toBe('1');
    expect(view.find('[data-fact="move"] output')?.textContent).toBe('Review');
    await view.click('[data-lifecycle="complete"]');
    await tick();
    expect(badge(view, 'agent')).toBeNull();
    expect(view.find('[data-fact="move"]')).toBeNull();
    await view.unmount();
  });

  it('a message rereads the task: a gate the reply opened is counted at once', async () => {
    const view = await mount(
      <TaskDetailScreen
        client={changing({}, { proposals: [open('a'), open('b')] })}
        grantKey="alpha:member"
        taskKey="Proj-Verity-Pacing"
      />,
    );
    await tick();
    expect(badge(view, 'agent')).toBeNull();
    await typeInto(view, '#comment-body', 'Please go ahead.');
    await view.click('[data-comment="post"]');
    await tick();
    expect(badge(view, 'agent')).toBe('2');
    expect(view.find('[data-fact="move"] output')?.textContent).toBe('Review');
    await view.unmount();
  });
});

const WORDS: Readonly<Record<PanelDoor, string>> = {
  open: 'Open this task in the panel',
  tick: 'Tick these off in the task panel',
  'add-first': 'Add the first one in the task panel',
  log: 'Log time in the task panel',
  timer: 'Start the timer in the task panel',
};

describe('MP-4-3 panel doors placed', () => {
  it('each door says where the edit happens and hands its kind to the panel', async () => {
    const opened: PanelDoor[] = [];
    for (const door of Object.keys(WORDS) as PanelDoor[]) {
      // eslint-disable-next-line no-await-in-loop -- one door at a time
      const view = await mount(
        <PanelDoorButton door={door} onOpenPanel={(kind) => opened.push(kind)} />,
      );
      expect(view.find(`[data-panel-door="${door}"]`)?.textContent).toBe(WORDS[door]);
      // eslint-disable-next-line no-await-in-loop -- one door at a time
      await view.click(`[data-panel-door="${door}"]`);
      // eslint-disable-next-line no-await-in-loop -- one door at a time
      await view.unmount();
    }
    expect(opened).toStrictEqual(Object.keys(WORDS));
  });
});

describe('MP-4-3 panel doors placed on the page', () => {
  it('the page places open by the switch, add-first on Team’s steps and log and timer on its time', async () => {
    const opened: PanelDoor[] = [];
    const view = await mount(
      <TaskDetailScreen
        client={server(found())}
        grantKey="alpha:member"
        taskKey="Proj-Verity-Pacing"
        onOpenPanel={(door) => opened.push(door)}
      />,
    );
    await tick();
    expect(view.find('[data-panel-door="open"]')?.closest('[role="tabpanel"]')).toBeNull();
    for (const door of ['add-first', 'log', 'timer']) {
      expect(view.find(`#perspective-panel-team [data-panel-door="${door}"]`)).not.toBeNull();
    }
    expect(view.find('#perspective-panel-team [data-steps] ')?.textContent).toContain(
      'No subtasks on this one yet.',
    );
    await view.click('#perspective-panel-team [data-panel-door="log"]');
    expect(opened).toStrictEqual(['log']);
    await view.unmount();
  });

  it('with no panel to open, a door is shown but cannot be pressed', async () => {
    const view = await page('Proj-Verity-Pacing', found());
    expect((view.find('[data-panel-door="open"]') as HTMLButtonElement | null)?.disabled).toBe(
      true,
    );
    await view.unmount();
  });
});

describe('MP-4-3 visual match', () => {
  it.todo('matches the mockup at 1480, 900 and 390, light and dark (MP-1-7 harness)');
});
