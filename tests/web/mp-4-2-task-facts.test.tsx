// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-2: the task page's facts block (TP-08 to TP-10): the strip (whose
// move, rank, the Ad hoc and Client access marks), the calc line and the
// ten-field band, each drawn from `task.read` as the stand-in answers it. The
// marks here are inert: the ticks that change them are MP-4-10's, in the dock
// panel. The harness captures (`MP-4-2 visual match`) wait on MP-1-7.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Mounted } from '../surfaces/mount.tsx';
import { found, page, proposalWith } from './task-page-stub.tsx';

const withFacts = async (over: Readonly<Record<string, unknown>> = {}) =>
  await page('Proj-Verity-Pacing', found(over));

const text = (view: Mounted, selector: string): string =>
  view.find(selector)?.textContent?.trim() ?? '';

const pendingGate = {
  lineageId: 'l-gated',
  state: 'open',
  versions: [
    {
      versionId: 'v1',
      version: 1,
      purpose: 'draft',
      maximumMinor: 100,
      currency: 'AUD',
      payloadDigest: 'd1',
      payload: {},
      supersededAt: null,
      runId: null,
      evidence: null,
      gate: {
        id: 'g1',
        state: 'pending',
        round: 1,
        expiresAt: '2999-01-01T00:00:00.000Z',
        expired: false,
        payloadDigest: 'd1',
      },
    },
  ],
  decisions: [],
  reservations: [],
};

const liveLease = {
  ...proposalWith('dispatched'),
  reservations: [
    {
      ...proposalWith('dispatched').reservations[0],
      lease: { id: 'le1', fence: 1, state: 'live', expiresAt: '', holderActorId: 'ag' },
    },
  ],
};

describe('MP-4-2 facts content', () => {
  it('whose move: Team by default, Review at an open gate, Agent under a live lease, none when done', async () => {
    const cases: readonly (readonly [Readonly<Record<string, unknown>>, string | null])[] = [
      [{}, 'Team'],
      [{ proposals: [pendingGate] }, 'Review'],
      [{ proposals: [liveLease] }, 'Agent'],
      [{ completedAt: '2026-09-20T00:00:00.000Z' }, null],
    ];
    for (const [over, move] of cases) {
      // eslint-disable-next-line no-await-in-loop -- one page at a time
      const view = await withFacts(over);
      expect(view.find('[data-fact="move"] output')?.textContent ?? null).toBe(move);
      // eslint-disable-next-line no-await-in-loop -- one page at a time
      await view.unmount();
    }
  });

  it('the rank is #N with its calc line, or "not ranked" naming the missing marks', async () => {
    const ranked = await withFacts();
    expect(text(ranked, '[data-fact="rank"] output')).toBe('#4');
    expect(text(ranked, '[data-calc]')).toBe('impact 7 × confidence 9 × ease 8 = 504 · derived');
    await ranked.unmount();
    const unranked = await withFacts({
      rank: { number: null, score: null, calc: 'not ranked: missing ease' },
    });
    expect(text(unranked, '[data-fact="rank"] output')).toBe('not ranked');
    expect(text(unranked, '[data-calc]')).toBe('not ranked: missing ease');
    await unranked.unmount();
  });

  it('the Ad hoc and Client access marks are the record’s, and Handling says the same', async () => {
    const both = await withFacts({ adHoc: true, clientAccess: true });
    expect(both.find('[data-mark="adhoc"]')?.getAttribute('aria-label')).toBe('Ad hoc: yes');
    expect(both.find('[data-mark="client-access"]')?.getAttribute('aria-label')).toBe(
      'Client access: yes',
    );
    expect(
      both.all('[data-field="handling"] [data-chip]').map((chip) => chip.textContent),
    ).toStrictEqual(['Ad hoc', 'Client access']);
    await both.unmount();
    const neither = await withFacts();
    expect(neither.find('[data-mark="adhoc"]')?.getAttribute('aria-label')).toBe('Ad hoc: no');
    expect(text(neither, '[data-field="handling"] dd')).toBe('Neither ad hoc nor client-visible');
    await neither.unmount();
  });
});

describe('MP-4-2 ten-field band', () => {
  it('holds exactly ten labelled fields, in order, each from the record', async () => {
    const view = await withFacts({
      assignee: { personId: 'p1', name: 'Callum Brierley' },
      due: '2026-08-01T00:00:00.000Z',
      stage: 'Awareness',
      clientSet: true,
    });
    const labels = view.all('[data-band] dt').map((label) => label.textContent);
    expect(labels).toStrictEqual([
      'Assignee',
      'Client',
      'Due date',
      'Estimate',
      'Project',
      'Category',
      'Stage',
      'Status',
      'Page link',
      'Handling',
    ]);
    expect(text(view, '[data-field="assignee"] dd')).toBe('Callum Brierley');
    expect(text(view, '[data-field="client"] dd')).toBe('On file');
    expect(text(view, '[data-field="due"] dd')).toBe('2026-08-01');
    expect(text(view, '[data-field="project"] dd')).toBe('Website Projects');
    expect(text(view, '[data-field="stage"] dd')).toBe('Awareness');
    expect(text(view, '[data-field="status"] dd')).toBe('Awaiting approval');
    await view.unmount();
  });

  it('an empty value reads "not set", and an empty Page link "nothing yet"', async () => {
    const view = await withFacts({
      board: null,
      state: null,
      stage: null,
      clientSet: false,
    });
    for (const field of ['assignee', 'client', 'due', 'estimate', 'project', 'category']) {
      expect(text(view, `[data-field="${field}"] dd`)).toBe('not set');
    }
    for (const field of ['stage', 'status']) {
      expect(text(view, `[data-field="${field}"] dd`)).toBe('not set');
    }
    expect(text(view, '[data-field="page-link"] dd')).toBe('nothing yet');
    await view.unmount();
  });
});

describe('MP-4-2 inert marks', () => {
  it('every mark with no action has no tab stop, no button role and no handler, and a click changes nothing', async () => {
    const view = await withFacts({ adHoc: true, clientAccess: true });
    const marks = view.all('[data-mark], [data-chip]') as HTMLElement[];
    expect(marks.length).toBeGreaterThanOrEqual(4);
    for (const mark of marks) {
      expect(mark.tagName).not.toBe('BUTTON');
      expect(mark.getAttribute('role')).not.toBe('button');
      expect(mark.getAttribute('role')).not.toBe('checkbox');
      expect(mark.hasAttribute('tabindex')).toBe(false);
      expect(mark.closest('button, a')).toBeNull();
    }
    const before = view.host.innerHTML;
    for (const mark of marks) mark.click();
    expect(view.host.innerHTML).toBe(before);
    await view.unmount();
  });

  it('the marks’ rule sets the default cursor, never the pointer (D-08)', () => {
    const css = readFileSync(
      join(import.meta.dirname, '../../packages/ui/src/styles/5-task.css'),
      'utf8',
    );
    const rule = /\.tpr__mark\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/cursor:\s*default/u);
  });
});

describe('MP-4-2 visual match', () => {
  it.todo('the rich agent task at 1480, 900 and 390, light and dark (MP-1-7 harness)');
});
