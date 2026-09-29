// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-3: the Team and Agent perspectives of one task (DP-11 to DP-13, TP-12,
// TT-06). One counting rule, `perspectiveCounts`, serves the page here and the
// dock task panel when MP-4-8 builds it (D-07 not copied): Team counts
// unfinished live subtasks, Agent counts open gates, else one for unshipped
// staged output. The panes are hidden by attribute, never unmounted, so what
// was typed in one survives a switch. The counts after a write and the panel
// doors are in `mp-4-3-panel-doors.test.tsx`.

import { afterEach, describe, expect, it } from 'vitest';
import type { ProposalView } from '../../packages/core-wire/src/index.ts';
import { found, tick } from './task-page-stub.tsx';
import {
  badge,
  counts,
  gated,
  open,
  page,
  paneHidden,
  press,
  step,
  unmountAll,
} from './perspective-support.tsx';

// A test that fails before its own unmount would leave its page mounted.
afterEach(unmountAll);

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
