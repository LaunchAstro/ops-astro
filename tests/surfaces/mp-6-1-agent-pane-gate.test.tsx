// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-6-1, the Agent pane's named tests continued: the decision on the exact
// version, reject, cancel and earlier attempts, the lifecycle word, and what
// shipped. Fixtures in `mp-6-1-agent-fixtures.tsx`.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, exactly as it was first written red */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStories, type RunLineage } from '../../packages/ui/src/index.ts';
import {
  DIGEST,
  lineage as fixtureLineage,
  pane,
  running,
  unmountAll,
  version,
} from './mp-6-1-agent-fixtures.tsx';

// Declared in this file so the lifecycle test's helper reads it from the
// file's own scope, as it did before the file was split.
function lineage(overrides: Partial<RunLineage> = {}): RunLineage {
  return fixtureLineage(overrides);
}

afterEach(unmountAll);

// eslint-disable-next-line max-lines-per-function -- one pane, each decision on it
describe('MP-6-1 agent pane', () => {
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
