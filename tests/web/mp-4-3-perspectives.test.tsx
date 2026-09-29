// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-3: the Team and Agent perspectives of one task (DP-11 to DP-13, TP-12,
// TT-06). One counting rule, `perspectiveCounts`, serves the page here and the
// dock task panel when MP-4-8 builds it (D-07 not copied): Team counts
// unfinished live subtasks, Agent counts open gates, else one for unshipped
// staged output. The panes are hidden by attribute, never unmounted, so what
// was typed in one survives a switch. The panel doors are placed here and
// wired by MP-4-8. The harness captures (`MP-4-3 visual match`) wait on
// MP-1-7.

import { act, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProposalView } from '../../packages/core-wire/src/index.ts';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import {
  PanelDoorButton,
  perspectiveCounts,
  type PanelDoor,
} from '../../apps/web/src/screens/task/Perspectives.tsx';
import { mount as mountOnce, type Mounted } from '../surfaces/mount.tsx';
import { found, page as pageOnce, server, task, tick, type Answers } from './task-page-stub.tsx';

// A test that fails before its own unmount leaves its page mounted, and a
// page left behind can disturb the next test's reads. Every view is unmounted
// after its test, whichever way the test ended.
const live = new Set<Mounted>();

const kept = (view: Mounted): Mounted => {
  live.add(view);
  return {
    ...view,
    unmount: async () => {
      if (!live.delete(view)) return;
      await view.unmount();
    },
  };
};

const mount = async (element: ReactElement): Promise<Mounted> => kept(await mountOnce(element));

const page = async (taskKey: string, answers: Answers): Promise<Mounted> =>
  kept(await pageOnce(taskKey, answers));

afterEach(async () => {
  for (const view of live) {
    live.delete(view);
    // eslint-disable-next-line no-await-in-loop -- one page at a time
    await view.unmount();
  }
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** One lineage whose head version carries a gate in this state. */
const gated = (
  name: string,
  gate: { readonly state: string; readonly expired?: boolean } | null,
  supersededAt: string | null = null,
): ProposalView => ({
  lineageId: `l-${name}`,
  state: 'live',
  versions: [
    {
      versionId: `v-${name}`,
      version: 1,
      purpose: 'draft',
      maximumMinor: 100,
      currency: 'AUD',
      payloadDigest: `d-${name}`,
      payload: {},
      supersededAt,
      runId: null,
      evidence: null,
      gate:
        gate === null
          ? null
          : {
              id: `g-${name}`,
              state: gate.state,
              round: 1,
              expiresAt: '2999-01-01T00:00:00.000Z',
              expired: gate.expired ?? false,
              payloadDigest: `d-${name}`,
            },
    },
  ],
  decisions: [],
  reservations: [],
});

const open = (name: string): ProposalView => gated(name, { state: 'pending' });

const step = (done: boolean, retired = false) => ({ done, retired });

const counts = (over: {
  readonly steps?: readonly { done: boolean; retired: boolean }[];
  readonly proposals?: readonly ProposalView[];
  readonly stagedOutput?: boolean;
}) =>
  perspectiveCounts({
    steps: over.steps ?? [],
    proposals: over.proposals ?? [],
    stagedOutput: over.stagedOutput ?? false,
  });

const badge = (view: Mounted, tab: string): string | null =>
  view.find(`[data-tabs="perspective"] #perspective-tab-${tab} .cbadge`)?.textContent ?? null;

const paneHidden = (view: Mounted, tab: string): boolean | undefined =>
  view.find(`#perspective-panel-${tab}`)?.hasAttribute('hidden');

const press = async (view: Mounted, selector: string, key: string): Promise<void> => {
  const target = view.find(selector);
  if (target === null) throw new Error(`nothing matches ${selector}`);
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
};

/** A keystroke into a textarea, through the element's own value setter. */
const typeInto = async (view: Mounted, selector: string, text: string): Promise<void> => {
  const field = view.host.querySelector(selector);
  if (field === null) throw new Error(`nothing matches ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
  await act(() => {
    setter?.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('MP-4-3 Team counts unfinished subtasks', () => {
  it('counts live steps not yet done; a done or retired step is not counted', () => {
    expect(counts({}).team).toBe(0);
    expect(counts({ steps: [step(false), step(false), step(true)] }).team).toBe(2);
    expect(counts({ steps: [step(false, true), step(true, true)] }).team).toBe(0);
  });
});

describe('MP-4-3 Agent counts an open gate, else staged output', () => {
  it('counts every open gate on a live version, and says so', () => {
    expect(counts({ proposals: [open('a')] })).toMatchObject({
      agent: 1,
      agentTitle: '1 open gate waiting on you',
    });
    expect(counts({ proposals: [open('a'), open('b')], stagedOutput: true })).toMatchObject({
      agent: 2,
      agentTitle: '2 open gates waiting on you',
    });
  });

  it('a decided, expired or superseded gate is not open', () => {
    const closed = [
      gated('approved', { state: 'approved' }),
      gated('rejected', { state: 'rejected' }),
      gated('expired', { state: 'expired', expired: true }),
      gated('late', { state: 'pending', expired: true }),
      gated('old', { state: 'pending' }, '2026-09-01T00:00:00.000Z'),
      gated('none', null),
    ];
    expect(counts({ proposals: closed })).toStrictEqual({ team: 0, agent: 0, agentTitle: '' });
  });

  it('with no open gate, unshipped staged output counts one', () => {
    expect(counts({ stagedOutput: true })).toStrictEqual({
      team: 0,
      agent: 1,
      agentTitle: 'Staged output waiting on you',
    });
  });
});

describe('MP-4-3 CS-4.8 switch perspectives', () => {
  it('opens on Team; Agent shows the proposals; a press or an arrow key switches', async () => {
    const view = await page('Proj-Verity-Pacing', found());
    expect(view.find('[role="tablist"][data-tabs="perspective"]')?.getAttribute('aria-label')).toBe(
      'Team and agent views of this task',
    );
    expect(view.find('#perspective-tab-team')?.getAttribute('aria-selected')).toBe('true');
    expect(paneHidden(view, 'team')).toBe(false);
    expect(paneHidden(view, 'agent')).toBe(true);
    expect(view.find('#perspective-panel-team #task-fields')).not.toBeNull();
    expect(view.find('#perspective-panel-agent [data-proposals="section"]')).not.toBeNull();

    await view.click('#perspective-tab-agent');
    expect(view.find('#perspective-tab-agent')?.getAttribute('aria-selected')).toBe('true');
    expect(paneHidden(view, 'team')).toBe(true);
    expect(paneHidden(view, 'agent')).toBe(false);
    // Hidden, never unmounted: the other side is still in the page.
    expect(view.find('#perspective-panel-team #task-fields')).not.toBeNull();

    await press(view, '#perspective-tab-agent', 'ArrowLeft');
    expect(paneHidden(view, 'team')).toBe(false);
    expect(paneHidden(view, 'agent')).toBe(true);
    await view.unmount();
  });
});

describe('MP-4-3 CS-4.8 the side showing belongs to this reading', () => {
  it('a reread keeps the side the reader chose', async () => {
    const view = await page('Proj-Verity-Pacing', found());
    await view.click('#perspective-tab-agent');
    await view.click('[data-refresh="task"]');
    await tick();
    expect(view.find('#perspective-tab-agent')?.getAttribute('aria-selected')).toBe('true');
    expect(paneHidden(view, 'agent')).toBe(false);
    await view.unmount();
  });
});

describe('MP-4-3 panes toggle without losing typing', () => {
  it('a title typed on Team is still there after a trip to Agent and back', async () => {
    const view = await page('Proj-Verity-Pacing', found());
    await view.type('#task-title', 'Typed before the switch');
    await view.click('#perspective-tab-agent');
    await view.click('#perspective-tab-team');
    expect((view.find('#task-title') as HTMLInputElement).value).toBe('Typed before the switch');
    await view.unmount();
  });
});

describe('MP-4-3 the same rule on the page and the panel', () => {
  it('the page draws exactly what the shared rule counts, and nothing at zero', async () => {
    const cases: readonly (readonly ProposalView[])[] = [
      [],
      [open('a')],
      [open('a'), open('b'), gated('done', { state: 'approved' })],
    ];
    for (const proposals of cases) {
      // eslint-disable-next-line no-await-in-loop -- one page at a time
      const view = await page('Proj-Verity-Pacing', found({ proposals }));
      const rule = counts({ proposals });
      expect(badge(view, 'agent')).toBe(rule.agent === 0 ? null : String(rule.agent));
      expect(badge(view, 'team')).toBe(rule.team === 0 ? null : String(rule.team));
      if (rule.agent > 0) {
        expect(view.find('#perspective-tab-agent .cbadge')?.getAttribute('title')).toBe(
          rule.agentTitle,
        );
      }
      // eslint-disable-next-line no-await-in-loop -- one page at a time
      await view.unmount();
    }
  });
});

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

describe('MP-4-3 panel doors placed', () => {
  const WORDS: Readonly<Record<PanelDoor, string>> = {
    open: 'Open this task in the panel',
    tick: 'Tick these off in the task panel',
    'add-first': 'Add the first one in the task panel',
    log: 'Log time in the task panel',
    timer: 'Start the timer in the task panel',
  };

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
