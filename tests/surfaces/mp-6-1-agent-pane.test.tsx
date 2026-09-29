// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-6-1, the Agent pane's named tests over stored lineages shaped exactly as
// `task.read`'s proposal projection returns them. The pane decides nothing:
// each control hands the exact gate and version it drew to the caller, and the
// caller's path is the real `task.decide` (`mp-6-1-agent-section.test.tsx`
// drives it through the task page's section). This file draws the run; the
// gate's decisions, attempts and lifecycle are in
// `mp-6-1-agent-pane-gate.test.tsx`.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, exactly as it was first written red */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { lineage, pane, unmountAll, version } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

// eslint-disable-next-line max-lines-per-function -- one pane, each part of it drawn
describe('MP-6-1 agent pane', () => {
  it('MP-6-1 brief invitation', async () => {
    const page = await pane({ lineages: [] });
    expect(page.find('[data-agent="invitation"]')?.textContent).toContain('Write a brief');
    expect(page.find('[data-agent="gate"]')).toBeNull();
  });

  it('MP-6-1 summary grid', async () => {
    const page = await pane();
    const summary = page.find('[data-agent="summary"]');
    expect(summary?.getAttribute('data-tone')).toBe('gate');
    expect(
      page.all('[data-agent="summary"] .trs__c').map((cell) => cell.getAttribute('data-summary')),
    ).toStrictEqual(['progress', 'current-job', 'blocked-by', 'next-action']);
  });

  it('MP-6-1 workflow groups', async () => {
    const checks = [
      {
        id: 'c1',
        name: 'spelling',
        outcome: 'passed',
        note: null,
        performedByActorId: 'a',
        recordedAt: 't',
      },
      {
        id: 'c2',
        name: 'links',
        outcome: 'failed',
        note: null,
        performedByActorId: 'a',
        recordedAt: 't',
      },
    ];
    const page = await pane({
      lineages: [lineage({ versions: [version({ checks })] })],
      jobListOpen: true,
    });
    const parallel = page.all('[data-agent="parallel"] [data-job]');
    expect(parallel.map((row) => row.getAttribute('data-job-state'))).toStrictEqual([
      'done',
      'failed',
    ]);
    expect(page.find('[data-agent="parallel"]')?.textContent).toContain('Run in parallel');
    expect(page.find('[data-agent="workflow"] button')?.textContent).toContain(
      'View 4-job workflow',
    );
  });

  it('MP-6-1 job list', async () => {
    const toggled: boolean[] = [];
    const page = await pane({ onJobList: (open) => toggled.push(open) });
    expect(page.find('.wf__list')?.hasAttribute('hidden')).toBe(true);
    await page.click('[data-agent="job-list"]');
    expect(toggled).toStrictEqual([true]);
  });

  it('MP-6-1 staged output kinds', async () => {
    const kinds = [
      { kind: 'diff', where: 'Home page', was: 'Old line', will: 'New line' },
      {
        kind: 'pr',
        repo: 'site',
        number: 7,
        title: 'Fix',
        files: 2,
        adds: 3,
        dels: 1,
        checks: 'green',
        href: 'https://example.test/pr/7',
      },
      {
        kind: 'ad',
        account: 'Acct',
        groups: [{ name: 'Brand', paused: true, band: 'low' }],
        spend: '$0',
      },
      { kind: 'preview', url: 'https://preview.example.test', built: 'built', note: 'a note' },
    ];
    for (const staged of kinds) {
      // eslint-disable-next-line no-await-in-loop -- one mount at a time
      const page = await pane({
        lineages: [
          lineage({ versions: [version({ evidence: { digest: 'e', body: { staged } } })] }),
        ],
      });
      expect(page.find('[data-agent="staged"] .sout__box')?.getAttribute('data-staged')).toBe(
        staged.kind,
      );
    }
  });

  it('MP-6-1 staged artefact', async () => {
    const staged = { kind: 'preview', url: 'https://preview.example.test', built: 'b', note: 'n' };
    const page = await pane({
      lineages: [lineage({ versions: [version({ evidence: { digest: 'e', body: { staged } } })] })],
    });
    const link = page.find('[data-agent="artefact"]');
    expect(link?.getAttribute('href')).toBe('https://preview.example.test/');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('MP-6-1 staged artefact refuses a hostile address', async () => {
    for (const url of [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '//evil.example.test/x',
      'vbscript:msgbox(1)',
    ]) {
      const staged = { kind: 'preview', url, built: 'b', note: 'n' };
      // eslint-disable-next-line no-await-in-loop -- one mount at a time
      const page = await pane({
        lineages: [
          lineage({ versions: [version({ evidence: { digest: 'e', body: { staged } } })] }),
        ],
      });
      expect(page.find('[data-agent="artefact"]'), url).toBeNull();
      expect(
        page.all('a').filter((a) => !/^https?:/u.test(a.getAttribute('href') ?? '')),
        url,
      ).toStrictEqual([]);
    }
  });

  it('MP-6-1 stale gate', async () => {
    const stale = lineage({
      versions: [
        version({ versionId: 'v-2', version: 2, gate: null }),
        version({ gate: { ...version().gate!, state: 'superseded' } }),
      ],
    });
    const page = await pane({ lineages: [stale] });
    expect(page.find('[data-agent="gate"]')?.getAttribute('data-gate-kind')).toBe('stale');
    expect(page.find('[data-gate-action="approve"]')).toBeNull();
    expect(page.find('[data-gate="stale"]')?.textContent).toContain('cannot be approved');
    expect(page.find('[data-gate-fact="invalidated"]')?.textContent).toContain('v2');
  });

  it('MP-6-1 gate box ported', async () => {
    const onDecide = vi.fn();
    const page = await pane({ onDecide });
    expect(page.text()).not.toContain('demonstration');
    await page.click('[data-gate-action="approve"]');
    await page.click('[data-gate-action="request_changes"]');
    expect(onDecide.mock.calls).toStrictEqual([
      [{ gateId: 'g-1', versionId: 'v-1' }, 'approve'],
      [{ gateId: 'g-1', versionId: 'v-1' }, 'request_changes'],
    ]);
    expect(page.all('[data-agent="gate-actions"] button')).toHaveLength(2);
  });
});
