// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-6-2's state revision lists on the Agent pane: the shown run's current
// knowledge and unknowns, and its earlier versions, as `task.read`'s ledger
// carries them (`tests/api/mp-6-2-states-read.test.ts` proves the read against
// Postgres). The panel only draws; the agent's text is shown as text.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import type { TaskLedger } from '../../packages/ui/src/index.ts';
import { lineage, pane, unmountAll } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

type State = NonNullable<TaskLedger['states']>[number];

const state = (version: number, overrides: Partial<State> = {}): State => ({
  runId: 'run-1',
  version,
  knowledge: [`knowledge at ${version}`],
  unknowns: [`unknown at ${version}`],
  revisedBy: { actorId: 'actor-agent' },
  revisedAt: `2026-09-30T0${version}:00:00.000Z`,
  ...overrides,
});

const statesWorld = (states?: readonly State[]) => ({
  ledger: { envelopes: [], ...(states === undefined ? {} : { states }) },
  lineages: [lineage()],
});

const texts = (nodes: readonly Element[]): readonly string[] =>
  nodes.map((node) => node.textContent ?? '');

describe('MP-6-2 state revision lists', () => {
  it('MP-6-2 revisions: the shown run’s newest version is its current knowledge with its unknowns, and the earlier versions are listed', async () => {
    const page = await pane(
      statesWorld([state(3), state(2), state(1), state(1, { runId: 'run-other' })]),
    );
    const panel = page.find('[data-agent="knowledge"]');
    expect(panel?.getAttribute('data-knowledge-version')).toBe('3');
    expect(texts(page.all('[data-knowledge="item"]'))).toStrictEqual(['knowledge at 3']);
    expect(texts(page.all('[data-knowledge="unknown"]'))).toStrictEqual(['unknown at 3']);
    expect(
      page.all('[data-knowledge="revision"]').map((node) => node.getAttribute('data-version')),
    ).toStrictEqual(['2', '1']);
    expect(page.text()).not.toContain('run-other');
  });

  it('MP-6-2 revisions: no version, or an older read, draws no knowledge panel', async () => {
    const none = await pane(statesWorld([]));
    expect(none.find('[data-agent="knowledge"]')).toBeNull();
    const older = await pane(statesWorld());
    expect(older.find('[data-agent="knowledge"]')).toBeNull();
  });

  it('MP-6-2 agent content inert: planted markup in knowledge and unknowns is shown as text and runs nothing', async () => {
    const planted = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    const page = await pane(statesWorld([state(1, { knowledge: [planted], unknowns: [planted] })]));
    const panel = page.find('[data-agent="knowledge"]');
    expect(panel?.querySelector('img, script')).toBeNull();
    expect(texts(page.all('[data-knowledge="item"]'))).toStrictEqual([planted]);
    expect((window as unknown as Record<string, unknown>)['__pwned']).toBeUndefined();
  });
});
