// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-6-1, the Agent pane's named tests over stored lineages shaped exactly as
// `task.read`'s proposal projection returns them. The pane decides nothing:
// each control hands the exact gate and version it drew to the caller, and the
// caller's path is the real `task.decide` (`tests/web/mp-6-1-agent-page.test.tsx`
// drives that end to end).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentPane,
  runStories,
  type AgentPaneProps,
  type RunLineage,
} from '../../packages/ui/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

const DIGEST = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

type Version = RunLineage['versions'][number];

function version(overrides: Partial<Version> = {}): Version {
  return {
    versionId: 'v-1',
    version: 1,
    purpose: 'draft_the_reply',
    maximumMinor: 2_500,
    currency: 'AUD',
    payloadDigest: DIGEST,
    payload: {},
    supersededAt: null,
    runId: 'run-1',
    evidence: { digest: 'e1', body: {} },
    gate: {
      id: 'g-1',
      state: 'pending',
      round: 0,
      expiresAt: '2026-10-01T00:00:00.000Z',
      expired: false,
      payloadDigest: DIGEST,
    },
    checks: [],
    ...overrides,
  };
}

function lineage(overrides: Partial<RunLineage> = {}): RunLineage {
  return {
    lineageId: 'l-1',
    state: 'live',
    versions: [version()],
    decisions: [],
    reservations: [],
    ...overrides,
  };
}

const running: RunLineage['reservations'][number] = {
  state: 'held',
  heldMinor: 2_500,
  actualMinor: null,
  classifiedCause: null,
  lease: { state: 'live' },
  attempt: { state: 'dispatched' },
};

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

async function pane(overrides: Partial<AgentPaneProps> = {}): Promise<Mounted> {
  const props: AgentPaneProps = {
    lineages: [lineage()],
    effect: null,
    nameOf: (id) => `person ${id}`,
    jobListOpen: false,
    onJobList: () => undefined,
    busy: false,
    refusal: null,
    onDecide: () => undefined,
    onReject: () => undefined,
    onCancel: () => undefined,
    ...overrides,
  };
  const page = await mount(<AgentPane {...props} />);
  live.push(page);
  return page;
}

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

  it('MP-6-1 decision on the exact version', async () => {
    const page = await pane();
    expect(page.find('[data-gate-action="approve"]')?.textContent).toBe('Approve exact v1');
    expect(page.find('[data-gate="digest"]')?.getAttribute('title')).toBe(DIGEST);

    const rounds = await pane({
      lineages: [lineage({ versions: [version({ gate: { ...version().gate!, round: 2 } })] })],
    });
    expect(rounds.find('[data-gate-action="request_changes"]')).toBeNull();
    expect(rounds.find('[data-gate-action="escalate"]')).not.toBeNull();

    const decided = await pane({
      lineages: [
        lineage({
          versions: [version({ gate: { ...version().gate!, state: 'approved' } })],
          decisions: [
            {
              decision: 'approve',
              decidedByPersonId: 'p-9',
              decidedAt: '2026-09-29T01:02:03.000Z',
            },
          ],
        }),
      ],
    });
    expect(decided.find('[data-gate="decided"]')?.textContent).toBe(
      'approve by person p-9 at 2026-09-29T01:02:03.000Z',
    );
  });

  it('MP-6-1 reject on the header', async () => {
    const onReject = vi.fn();
    const page = await pane({ onReject });
    expect(page.find('[data-agent="gate"] [data-agent="reject"]')).toBeNull();
    await page.click('[data-agent="proposal-header"] [data-agent="reject"]');
    expect(onReject.mock.calls).toStrictEqual([[{ gateId: 'g-1', versionId: 'v-1' }]]);
  });

  it('MP-6-1 earlier attempts', async () => {
    const onCancel = vi.fn();
    const older = lineage({ lineageId: 'l-0', state: 'rejected' });
    const current = lineage({ lineageId: 'l-1', reservations: [running] });
    const page = await pane({ lineages: [current, older], onCancel });
    expect(page.find('[data-agent="pane"]')?.getAttribute('data-agent-lineage')).toBe('l-1');
    await page.click('[data-attempt="1"]');
    expect(page.find('[data-agent="pane"]')?.getAttribute('data-agent-lineage')).toBe('l-0');
    expect(page.find('[data-agent="state-word"]')?.textContent).toBe('Rejected');
    await page.click('[data-attempt="2"]');
    await page.click('[data-agent="cancel"]');
    expect(onCancel.mock.calls).toStrictEqual([['l-1']]);

    const ended = await pane({ lineages: [older] });
    expect(ended.find('[data-agent="start"]')?.hasAttribute('disabled')).toBe(true);
  });

  it('MP-6-1 run lifecycle', () => {
    const word = (overrides: Partial<RunLineage>): string | undefined =>
      runStories([lineage(overrides)]).at(-1)?.word;
    expect(word({})).toBe('At human gate');
    expect(word({ reservations: [running] })).toBe('Running');
    expect(word({ reservations: [{ ...running, state: 'quarantined', lease: null }] })).toBe(
      'Outcome unknown',
    );
    expect(word({ reservations: [{ ...running, state: 'abandoned', lease: null }] })).toBe(
      'Dropped',
    );
    expect(word({ state: 'cancelled' })).toBe('Cancelled');
    expect(word({ state: 'completed' })).toBe('Done');
  });

  it('MP-6-1 one story', () => {
    for (const overrides of [
      {},
      { state: 'rejected' },
      { reservations: [running] },
      { versions: [version({ gate: { ...version().gate!, expired: true } })] },
    ] as Partial<RunLineage>[]) {
      const story = runStories([lineage(overrides)]).at(-1)!;
      const armed = story.gate.kind === 'armed';
      expect(armed).toBe(story.state === 'at-gate');
      expect(story.blockedBy === 'Human approval').toBe(armed);
      expect(story.jobs.some((job) => job.state === 'pending')).toBe(armed);
    }
  });

  it('MP-6-1 stored proposals drawn', async () => {
    const page = await pane({
      lineages: [lineage({ versions: [version({ runId: 'run-stored' })] })],
    });
    expect(page.find('[data-agent="run-id"]')?.textContent).toBe('run-stored');
    expect(page.find('[data-agent="gate"]')?.getAttribute('data-gate-id')).toBe('g-1');
  });

  it('MP-6-1 effect notice and currency', async () => {
    const said = await pane({ effect: 'Posts one team-only comment.' });
    expect(said.find('[data-gate-fact="unlocks"]')?.textContent).toContain(
      'Posts one team-only comment.',
    );
    const usd = await pane({ lineages: [lineage({ versions: [version({ currency: 'USD' })] })] });
    expect(usd.find('[data-gate-fact="unlocks"]')?.textContent).toContain('USD 25.00');
  });

  it('MP-6-1 roll back unavailable', async () => {
    const shipped = { at: '2026-09-29', artefact: 'v1', snapshot: 'snap-1', rolledBackAt: null };
    const page = await pane({
      lineages: [
        lineage({
          state: 'completed',
          versions: [version({ evidence: { digest: 'e', body: { shipped } } })],
        }),
      ],
    });
    expect(page.find('[data-agent="roll-back"]')?.hasAttribute('disabled')).toBe(true);
    expect(page.find('[data-agent="roll-back-reason"]')?.textContent).toContain('own approval');
    expect(page.find('[data-agent="snapshot"]')?.textContent).toBe('snap-1');
  });
});
